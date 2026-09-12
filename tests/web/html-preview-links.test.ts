/**
 * Links inside a previewed HTML file: which ones the Files panel takes over.
 *
 * The 2026-09-11 report: a report's link to the video it produced navigated the
 * preview IFRAME (to a URL the site could not even serve), and the panel's ‹ ›
 * knew nothing about it, so the only way back was to click some other file
 * first. The classifier decides per click: another file on this host → the panel
 * opens it; another site → outside the pane; anchors and self links → browser.
 */
import { describe, it, expect } from 'vitest'

import { classifyPreviewLink, classifyPreviewNavigation, previewFileTarget } from '../../web/src/utils/html-preview-links.js'
import { rawFileContentUrl } from '../../web/src/api/files.js'

const ORIGIN = 'http://localhost:3456'
const DOC_PATH = '/tmp/report/index.html'
const DOC = `${ORIGIN}${rawFileContentUrl(DOC_PATH, undefined, 2)}`
const CURRENT = { path: DOC_PATH, host: undefined }

describe('previewFileTarget', () => {
  it('round-trips the URL the client builds, per-segment decoding included', () => {
    const p = '/tmp/odd name #1/clip?.webm'
    expect(previewFileTarget(new URL(rawFileContentUrl(p), ORIGIN).pathname)).toEqual({ host: undefined, path: p })
    expect(previewFileTarget(new URL(rawFileContentUrl(p, 'devbox'), ORIGIN).pathname)).toEqual({ host: 'devbox', path: p })
    expect(previewFileTarget(new URL(rawFileContentUrl('~/proj/a.html', 'devbox'), ORIGIN).pathname))
      .toEqual({ host: 'devbox', path: '~/proj/a.html' })
    expect(previewFileTarget('/api/v1/file-raw/local/tmp/a.html')).toEqual({ host: undefined, path: '/tmp/a.html' })
  })

  it('reads a root-absolute path as a file on the document’s own host', () => {
    expect(previewFileTarget('/tmp/report/video.webm')).toEqual({ host: undefined, path: '/tmp/report/video.webm' })
    expect(previewFileTarget('/tmp/a%20b/x.png', 'devbox')).toEqual({ host: 'devbox', path: '/tmp/a b/x.png' })
  })

  it('reads the query-shaped document URL a cloud replica serves the preview from', () => {
    expect(previewFileTarget(`${ORIGIN}/api/file-content?path=%2Ftmp%2Freport%2Findex.html&raw=1`))
      .toEqual({ host: undefined, path: '/tmp/report/index.html' })
    expect(previewFileTarget('/api/v1/file-content?path=%2Ftmp%2Fa.html&raw=1&host=devbox'))
      .toEqual({ host: 'devbox', path: '/tmp/a.html' })
    // A JSON read of the same route is not a document.
    expect(previewFileTarget('/api/file-content?path=%2Ftmp%2Fa.md')).toBeNull()
  })

  it('is null for API calls, the site root, directories and malformed encodings', () => {
    expect(previewFileTarget('/api/config')).toBeNull()
    expect(previewFileTarget('/api')).toBeNull()
    expect(previewFileTarget('/')).toBeNull()
    expect(previewFileTarget('/tmp/report/')).toBeNull()
    expect(previewFileTarget('/api/file-raw/local/')).toBeNull()
    expect(previewFileTarget('/api/file-raw/local/tmp/')).toBeNull()
    expect(previewFileTarget('/tmp/%E0%A4%A')).toBeNull()
  })
})

describe('classifyPreviewNavigation', () => {
  it('tells the file itself from another file on the same host from nothing the panel can open', () => {
    expect(classifyPreviewNavigation(DOC, CURRENT)).toBe('same-file')
    expect(classifyPreviewNavigation(`${ORIGIN}${rawFileContentUrl('/tmp/report/details.html')}`, CURRENT))
      .toEqual({ kind: 'file', path: '/tmp/report/details.html' })
    expect(classifyPreviewNavigation(`${ORIGIN}/tmp/report/`, CURRENT)).toBeNull()
    expect(classifyPreviewNavigation(`${ORIGIN}/api/file-raw/otherbox/tmp/x.html`, CURRENT)).toBeNull()
    expect(classifyPreviewNavigation('about:blank', CURRENT)).toBeNull()
    // The cloud replica's document URL still counts as the file itself.
    expect(classifyPreviewNavigation(`${ORIGIN}/api/file-content?path=${encodeURIComponent(DOC_PATH)}&raw=1`, CURRENT)).toBe('same-file')
  })
})

describe('classifyPreviewLink', () => {
  it('a root-absolute filesystem link → open that file in the panel', () => {
    expect(classifyPreviewLink(`${ORIGIN}/tmp/report/candidate/video.webm`, DOC, CURRENT))
      .toEqual({ kind: 'file', path: '/tmp/report/candidate/video.webm' })
  })

  it('a relative link (already resolved by the browser onto the file-raw route) → that file', () => {
    const href = new URL('details.html', DOC).href
    expect(classifyPreviewLink(href, DOC, CURRENT)).toEqual({ kind: 'file', path: '/tmp/report/details.html' })
    const up = new URL('../shared/notes.md', DOC).href
    expect(classifyPreviewLink(up, DOC, CURRENT)).toEqual({ kind: 'file', path: '/tmp/shared/notes.md' })
  })

  it('in-page anchors and self links stay with the browser', () => {
    expect(classifyPreviewLink(new URL('#tail', DOC).href, DOC, CURRENT)).toEqual({ kind: 'passthrough' })
    expect(classifyPreviewLink(new URL('index.html#tail', DOC).href, DOC, CURRENT)).toEqual({ kind: 'passthrough' })
    expect(classifyPreviewLink(`${ORIGIN}${DOC_PATH}`, DOC, CURRENT)).toEqual({ kind: 'passthrough' })
  })

  it('another website → external, opened outside the pane', () => {
    expect(classifyPreviewLink('https://example.com/docs', DOC, CURRENT))
      .toEqual({ kind: 'external', url: 'https://example.com/docs' })
    // Another port on localhost is another site too (an agent's dev server).
    expect(classifyPreviewLink('http://localhost:5173/', DOC, CURRENT))
      .toEqual({ kind: 'external', url: 'http://localhost:5173/' })
  })

  it('a directory link passes through (the panel has no viewer for it)', () => {
    expect(classifyPreviewLink(new URL('../', DOC).href, DOC, CURRENT)).toEqual({ kind: 'passthrough' })
    expect(classifyPreviewLink(`${ORIGIN}/tmp/report/`, DOC, CURRENT)).toEqual({ kind: 'passthrough' })
  })

  it('non-http schemes, API URLs and other hosts pass through', () => {
    expect(classifyPreviewLink('mailto:someone@example.com', DOC, CURRENT)).toEqual({ kind: 'passthrough' })
    expect(classifyPreviewLink('javascript:void(0)', DOC, CURRENT)).toEqual({ kind: 'passthrough' })
    expect(classifyPreviewLink(`${ORIGIN}/api/config`, DOC, CURRENT)).toEqual({ kind: 'passthrough' })
    expect(classifyPreviewLink(`${ORIGIN}/api/file-raw/otherbox/tmp/x.html`, DOC, CURRENT)).toEqual({ kind: 'passthrough' })
    expect(classifyPreviewLink('not a url', 'also not', CURRENT)).toEqual({ kind: 'passthrough' })
  })

  it('a remote-host document keeps its host on file targets', () => {
    const remoteDoc = `${ORIGIN}${rawFileContentUrl('~/proj/index.html', 'devbox')}`
    const current = { path: '~/proj/index.html', host: 'devbox' }
    expect(classifyPreviewLink(new URL('out/report.html', remoteDoc).href, remoteDoc, current))
      .toEqual({ kind: 'file', path: '~/proj/out/report.html' })
    expect(classifyPreviewLink(`${ORIGIN}/home/me/x.png`, remoteDoc, current))
      .toEqual({ kind: 'file', path: '/home/me/x.png' })
  })
})
