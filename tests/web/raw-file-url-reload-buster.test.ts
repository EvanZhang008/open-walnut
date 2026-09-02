import { describe, expect, it } from 'vitest'

import { rawFileContentUrl } from '../../web/src/api/files.js'

// Regression: the Files-panel Refresh button was a silent no-op for every
// raw-rendered kind (HTML preview iframe, images, PDF, video/audio). The
// browser never re-navigates an <iframe>/<img>/<video> whose src is
// byte-identical, so the reloadToken must change the URL itself.
describe('rawFileContentUrl reload buster', () => {
  it('is stable when no reload token is passed (first load, cacheable)', () => {
    const url = rawFileContentUrl('/tmp/a/index.html')
    expect(url).toBe(rawFileContentUrl('/tmp/a/index.html'))
    expect(url).not.toContain('r=')
  })

  it('token 0 (initial pane state) leaves the URL unchanged', () => {
    expect(rawFileContentUrl('/tmp/a/index.html', undefined, 0))
      .toBe(rawFileContentUrl('/tmp/a/index.html'))
  })

  it('each Refresh produces a distinct URL so the browser re-fetches', () => {
    const first = rawFileContentUrl('/tmp/a/index.html', 'clouddev', 1)
    const second = rawFileContentUrl('/tmp/a/index.html', 'clouddev', 2)
    expect(first).not.toBe(second)
    expect(new URL(first, 'http://x').searchParams.get('r')).toBe('1')
    expect(new URL(second, 'http://x').searchParams.get('r')).toBe('2')
  })

  // The URL is PATH-shaped, not query-shaped, and that is load-bearing: a
  // previewed HTML document resolves its relative `<img src="diagram.png">`
  // against its own URL's path, and the query string is dropped. From
  // `?path=…&raw=1` every relative image in every previewed file resolved to
  // `/api/diagram.png` and broke. So the assertion is that the buster rides
  // ALONGSIDE an intact path, host segment and per-component encoding.
  it('keeps the encoded path and host segments intact alongside the buster', () => {
    const url = new URL(rawFileContentUrl('/tmp/a b/c.png', 'devbox', 3), 'http://x')
    expect(url.pathname).toBe('/api/file-raw/devbox/tmp/a%20b/c.png')
    expect(url.searchParams.get('r')).toBe('3')
    // A sibling of the file resolves to a sibling of the route — the whole point.
    expect(new URL('other.png', url).pathname).toBe('/api/file-raw/devbox/tmp/a%20b/other.png')
  })

  it('encodes each path component, so #, ? and spaces in a filename survive', () => {
    const url = new URL(rawFileContentUrl('/tmp/w s/a#b?c.md', undefined, 1), 'http://x')
    expect(url.pathname).toBe('/api/file-raw/local/tmp/w%20s/a%23b%3Fc.md')
    expect(url.searchParams.get('r')).toBe('1')
  })
})
