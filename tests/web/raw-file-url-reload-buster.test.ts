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

  it('keeps path/raw/host params intact alongside the buster', () => {
    const params = new URL(rawFileContentUrl('/tmp/a b/c.png', 'devbox', 3), 'http://x').searchParams
    expect(params.get('path')).toBe('/tmp/a b/c.png')
    expect(params.get('raw')).toBe('1')
    expect(params.get('host')).toBe('devbox')
    expect(params.get('r')).toBe('3')
  })
})
