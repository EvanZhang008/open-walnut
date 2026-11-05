/**
 * Guard: no route serves an HTML, SVG or XML document of a file's content on Walnut's own origin
 * without the CSP sandbox (src/web/untrusted-doc.ts). A script in such a document runs with this
 * origin's storage (the Passwords unlock, the device token) unless the response gives it an
 * origin of its own.
 *
 * 1. Source scan: every server file that names a document content type, serves files from disk
 *    (`sendFile`, `express.static`) or writes such a type itself either goes through the helper
 *    (`sandboxUntrustedDoc` / `sendRawText`), sets a CSP of its own with `sandbox`, or is listed
 *    below with why it is safe. A new one fails here until it is one of those.
 * 2. Behaviour: the raw route's two senders (text and bytes) answer an HTML, SVG and XHTML type
 *    with the sandbox and leave other types alone, and an HTML document gets the preview bridge.
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-untrusted-doc'))
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { UNTRUSTED_DOC_CSP, isScriptableDocType } from '../../src/web/untrusted-doc.js'
import { withPreviewBridge } from '../../src/web/preview-bridge.js'

const ROOT = path.resolve(__dirname, '../..')
const SCAN_DIRS = ['src/web', 'src/host-server', 'src/replica']

/** Files that serve such content without the helper, and why that is safe. */
const SAFE: Record<string, string> = {
  'src/web/server.ts': 'Walnut\'s own built web app (static roots and index.html), not a file\'s content',
  'src/web/routes/apps.ts': 'a plugin\'s app assets: code the user installed (a plugin already runs in the server), framed without allow-same-origin (PluginAppPage)',
  'src/web/routes/human-inbox-body.ts': 'a letter body under its own stricter CSP (BODY_CSP: sandbox, no scripts)',
  'src/web/routes/plugin-icon-route.ts': 'a plugin icon SVG under ICON_CSP (sandbox, no scripts)',
  'src/host-server/pages.ts': 'Walnut\'s own page with a nonce CSP of its own, no file content',
  'src/replica/dispatch.ts': 'reads the Accept header only',
}

const DOC_TYPE = /['"`](text\/html|image\/svg\+xml|application\/xhtml\+xml|text\/xml|application\/xml)/
const SERVES_FILES = /\.sendFile\(|express\.static\(|\.type\(\s*['"](html|svg|xml|xhtml)['"]\s*\)/

function codeOf(text: string): string {
  // Comments name these types in prose; only code counts.
  return text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
}

function* tsFiles(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* tsFiles(p)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) yield p
  }
}

describe('documents served from a file never run with Walnut\'s origin', () => {
  it('every server file that serves an HTML, SVG or XML type is sandboxed or listed with why', () => {
    const offenders: string[] = []
    const seen = new Set<string>()
    for (const d of SCAN_DIRS) {
      const abs = path.join(ROOT, d)
      if (!fs.existsSync(abs)) continue
      for (const f of tsFiles(abs)) {
        const rel = path.relative(ROOT, f).split(path.sep).join('/')
        if (rel === 'src/web/untrusted-doc.ts') continue
        const code = codeOf(fs.readFileSync(f, 'utf8'))
        if (!DOC_TYPE.test(code) && !SERVES_FILES.test(code)) continue
        seen.add(rel)
        if (/sandboxUntrustedDoc|sendRawText/.test(code)) continue
        if (/Content-Security-Policy/i.test(code) && /sandbox/.test(code)) continue
        if (SAFE[rel]) continue
        offenders.push(rel)
      }
    }
    expect(offenders, 'serve these through sandboxUntrustedDoc/sendRawText (src/web/untrusted-doc.ts), or list them in SAFE with why').toEqual([])
    // The raw route itself is one of the files found, so the scan reaches it.
    expect(seen.has('src/web/routes/file-content.ts')).toBe(true)
    // A listed file that no longer serves such content leaves the list.
    expect(Object.keys(SAFE).filter((f) => !seen.has(f))).toEqual([])
  })

  it('knows the document types', () => {
    for (const t of ['text/html; charset=utf-8', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/xml', 'application/rss+xml']) expect(isScriptableDocType(t)).toBe(true)
    for (const t of ['text/plain; charset=utf-8', 'text/css', 'text/javascript', 'application/json', 'image/png', 'application/pdf', 'video/mp4']) expect(isScriptableDocType(t)).toBe(false)
  })

  it('puts the preview bridge after the doctype and inside the head', () => {
    const page = '<!DOCTYPE html>\n<html lang="en"><head><title>x</title></head><body>hi</body></html>'
    const out = withPreviewBridge(page)
    expect(out.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(out.indexOf('data-walnut-preview')).toBeGreaterThan(out.indexOf('<head>'))
    expect(out.indexOf('data-walnut-preview')).toBeLessThan(out.indexOf('<title>'))
    const bare = withPreviewBridge('<!doctype html><p>no head</p>')
    expect(bare.startsWith('<!doctype html><script data-walnut-preview>')).toBe(true)
    expect(withPreviewBridge('<p>fragment</p>').startsWith('<script data-walnut-preview>')).toBe(true)
  })
})

describe('the raw route\'s senders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-untrusted-doc-'))
  let server: http.Server | null = null
  afterAll(() => {
    server?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function serve(): Promise<string> {
    const { sendRawText, serveRawBytes, rawTextMime } = await import('../../src/web/routes/file-content.js')
    const app = express()
    app.get('/text/:name', (req, res) => {
      const name = req.params.name
      sendRawText(res, path.extname(name).slice(1), fs.readFileSync(path.join(dir, name), 'utf8'))
    })
    app.get('/bytes/:name', (req, res, next) => {
      const name = req.params.name
      serveRawBytes(req, res, path.join(dir, name), undefined, rawTextMime(path.extname(name).slice(1)), false).catch(next)
    })
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>((r) => server!.once('listening', () => r()))
    return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
  }

  it('sandbox an HTML and an SVG document on both paths, and nothing else', async () => {
    fs.writeFileSync(path.join(dir, 'page.html'), '<!doctype html><html><head></head><body><script>1</script></body></html>')
    fs.writeFileSync(path.join(dir, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')
    fs.writeFileSync(path.join(dir, 'style.css'), 'body{}')
    const base = await serve()
    for (const route of ['text', 'bytes']) {
      for (const name of ['page.html', 'pic.svg']) {
        const r = await fetch(`${base}/${route}/${name}`)
        expect(r.headers.get('content-security-policy'), `${route} ${name}`).toBe(UNTRUSTED_DOC_CSP)
        expect(r.headers.get('x-content-type-options')).toBe('nosniff')
      }
      const css = await fetch(`${base}/${route}/style.css`)
      expect(css.headers.get('content-security-policy')).toBeNull()
    }
    expect(UNTRUSTED_DOC_CSP).not.toContain('allow-same-origin')
    const html = await (await fetch(`${base}/text/page.html`)).text()
    expect(html).toContain('data-walnut-preview')
    const svg = await (await fetch(`${base}/text/pic.svg`)).text()
    expect(svg).not.toContain('data-walnut-preview')
  })
})
