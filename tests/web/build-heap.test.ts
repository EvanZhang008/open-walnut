/**
 * The web build gets room for its heap wherever it is started (web/build-heap.ts). 2026-11-16:
 * two Nightly extra tests jobs ran Node out of memory in `vite build` at the 2 GB default heap of
 * a 7 GB macOS runner; the build needed about 1.85 GB.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUILD_HEAP_ENV, BUILD_HEAP_MB, buildHeapRerun } from '../../web/build-heap'

const MB = 1024 * 1024
const ROOT = path.resolve(import.meta.dirname, '../..')
const argv = ['/usr/bin/node', '/repo/web/node_modules/vite/bin/vite.js', 'build', '--mode', 'production']

describe('the web build reruns itself with room for its heap', () => {
  it('a Node build on a 2 GB heap reruns with the same arguments and a bigger heap', () => {
    expect(buildHeapRerun(argv, {}, 2048 * MB, false)).toEqual({
      args: [`--max-old-space-size=${BUILD_HEAP_MB}`, '/repo/web/node_modules/vite/bin/vite.js', 'build', '--mode', 'production'],
      env: { [BUILD_HEAP_ENV]: '1' },
    })
  })

  it('the rerun never reruns itself again, even if its heap is still small', () => {
    expect(buildHeapRerun(argv, { [BUILD_HEAP_ENV]: '1' }, 2048 * MB, false)).toBeNull()
  })

  it('a heap already big enough, a dev server and Bun run as they are', () => {
    expect(buildHeapRerun(argv, {}, BUILD_HEAP_MB * MB, false)).toBeNull()
    expect(buildHeapRerun(['/usr/bin/node', '/repo/web/node_modules/vite/bin/vite.js'], {}, 2048 * MB, false)).toBeNull()
    expect(buildHeapRerun(['/usr/bin/node', 'vite.js', 'preview'], {}, 2048 * MB, false)).toBeNull()
    expect(buildHeapRerun(argv, {}, 2048 * MB, true)).toBeNull()
  })

  it('the Vite config calls it before it defines the build', () => {
    const config = fs.readFileSync(path.join(ROOT, 'web/vite.config.ts'), 'utf8')
    const call = config.indexOf('ensureBuildHeap();')
    expect(call).toBeGreaterThan(0)
    expect(call).toBeLessThan(config.indexOf('export default defineConfig'))
  })
})
