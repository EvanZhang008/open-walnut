/**
 * What a heartbeat sample may carry since views, files and plugin items: the
 * validator keeps the view word (a known one), the plugin slug and the reply mode
 * on the record that is synced, and splits the names (file, item, label) off for
 * the Mac-local detail file. The day-file reader and the compaction keep the
 * new record fields.
 */

import { describe, expect, it } from 'vitest'
import { sampleDetail, sanitizeSample } from '../../../src/core/time-tracking/rollup.js'
import { parseLine } from '../../../src/core/time-tracking/store-read.js'

const NOW = new Date('2026-10-05T18:00:00.000Z')
const base = { ts: '2026-10-05T17:00:00.000Z', durationMs: 30_000 }

describe('sanitizeSample', () => {
  it('keeps a known view, drops an unknown one, and never copies a name into the record', () => {
    const rec = sanitizeSample({ ...base, kind: 'session', sessionId: 's1', view: 'files', file: '/repo/a.ts' }, NOW)
    expect(rec).toEqual({ date: expect.any(String), ts: base.ts, durationMs: 30_000, kind: 'session', sessionId: 's1', view: 'files' })
    expect(sanitizeSample({ ...base, kind: 'session', view: 'settings' }, NOW)).not.toHaveProperty('view')
  })

  it('accepts kind app with a slug and the reply mode; app and mode mean nothing on other kinds', () => {
    expect(sanitizeSample({ ...base, kind: 'app', app: 'chatapp', mode: 'reply', item: 'C1', label: '#general' }, NOW))
      .toMatchObject({ kind: 'app', app: 'chatapp', mode: 'reply' })
    expect(sanitizeSample({ ...base, kind: 'app', app: 'Chat App!', mode: 'shout' }, NOW)).toEqual(expect.not.objectContaining({ app: expect.anything() }))
    expect(sanitizeSample({ ...base, kind: 'session', app: 'chatapp', mode: 'reply' }, NOW)).toEqual(expect.not.objectContaining({ mode: 'reply' }))
  })

  it('splits off the local detail, cleaned: control characters refused, long text cut', () => {
    expect(sampleDetail({ kind: 'session', file: '  /repo/a.ts ' })).toEqual({ file: '/repo/a.ts' })
    expect(sampleDetail({ kind: 'app', item: 'C1', label: '#general' })).toEqual({ item: 'C1', label: '#general' })
    // item and label only belong to plugin items.
    expect(sampleDetail({ kind: 'session', item: 'C1', label: 'x' })).toEqual({})
    expect(sampleDetail({ kind: 'session', file: 'a\u0000b' })).toEqual({})
    expect(sampleDetail({ kind: 'app', label: 'x'.repeat(2000) }).label).toHaveLength(512)
    expect(sampleDetail(null)).toEqual({})
  })
})

describe('parseLine', () => {
  it('reads view, app and mode back, and drops values no build wrote', () => {
    expect(parseLine(JSON.stringify({ date: '2026-10-05', ts: base.ts, durationMs: 1000, kind: 'app', app: 'chatapp', mode: 'reply' }), '2026-10-05'))
      .toMatchObject({ kind: 'app', app: 'chatapp', mode: 'reply' })
    expect(parseLine(JSON.stringify({ date: '2026-10-05', ts: base.ts, durationMs: 1000, kind: 'session', view: 'files' }), '2026-10-05'))
      .toMatchObject({ view: 'files' })
    const junk = parseLine(JSON.stringify({ date: '2026-10-05', ts: base.ts, durationMs: 1000, kind: 'session', view: 'nope', mode: 'x' }), '2026-10-05')
    expect(junk).not.toHaveProperty('view')
    expect(junk).not.toHaveProperty('mode')
  })
})
