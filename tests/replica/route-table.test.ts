/**
 * The route table of a host replica (docs/plan/walnut-replica-servers-impl.md,
 * section 3, WP2): first match wins, the defaults (GET read, any other method
 * needs the Mac, class leader), the express-like patterns, and the rows of the
 * phone app's own calls.
 */
import { describe, it, expect } from 'vitest'
import { classify, journals, methodMatches, patternMatches, isRead, ROUTE_TABLE, type RouteRow } from '../../src/replica/route-table.js'

describe('patterns', () => {
  it.each([
    ['/api/v1/tasks/:id', '/api/v1/tasks/task-acme-1', true],
    ['/api/v1/tasks/:id', '/api/v1/tasks', false],
    ['/api/v1/tasks/:id', '/api/v1/tasks/a/b', false],
    ['/api/v1/*', '/api/v1/tasks/a/b', true],
    ['/api/v1/*', '/api/v1', true],
    ['/api/v1/*', '/api/v2/tasks', false],
    ['/api/v1/status', '/API/V1/Status', true],
    ['/api/v1/status', '/api/v1/status/', true],
  ])('%s against %s is %s', (pattern, p, want) => {
    expect(patternMatches(pattern, p)).toBe(want)
  })

  it('WRITE is every method but GET, HEAD and OPTIONS; GET also takes HEAD; * takes all', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(methodMatches('WRITE', m)).toBe(true)
    for (const m of ['GET', 'HEAD', 'OPTIONS']) expect(methodMatches('WRITE', m)).toBe(false)
    expect(methodMatches('GET', 'HEAD')).toBe(true)
    expect(methodMatches('GET', 'POST')).toBe(false)
    expect(methodMatches('*', 'DELETE')).toBe(true)
    expect(methodMatches('POST', 'post')).toBe(true)
    expect(isRead('options')).toBe(true)
  })
})

describe('classify', () => {
  it('a route no row names: GET is read, a write needs the Mac, the class is leader', () => {
    expect(classify('GET', '/some/page')).toMatchObject({ cls: 'leader', away: 'read', row: null })
    expect(classify('POST', '/some/page')).toMatchObject({ cls: 'leader', away: 'needs-leader', row: null })
  })

  it('every write under /api has an explicit row that needs the Mac (until WP10 journals one)', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const d = classify(m, '/api/notes/a.md')
      expect(d.away).toBe('needs-leader')
      expect(d.row).not.toBeNull()
    }
  })

  it('the phone app\'s calls each have their row: reads read, writes need the Mac with a reason', () => {
    for (const p of ['/api/v1/status', '/api/v1/instance', '/api/v1/me', '/api/v1/tasks', '/api/v1/tasks/t1', '/api/v1/sessions', '/api/v1/sessions/s1', '/api/v1/sessions/s1/history']) {
      const d = classify('GET', p)
      expect(d.away, p).toBe('read')
      expect(d.row?.pattern.includes('*'), p).toBe(false)
    }
    expect(classify('POST', '/api/v1/tasks')).toMatchObject({ away: 'needs-leader', why: 'task_writes_need_mac' })
    expect(classify('PATCH', '/api/v1/tasks/t1')).toMatchObject({ away: 'needs-leader', why: 'task_writes_need_mac' })
    expect(classify('POST', '/api/v1/sessions/s1/messages')).toMatchObject({ away: 'needs-leader', why: 'session_writes_need_mac' })
    expect(classify('POST', '/api/v1/devices/self')).toMatchObject({ away: 'needs-leader', why: 'device_changes_need_mac' })
  })

  it('plugin routes are the Mac\'s by prefix, reads too', () => {
    expect(classify('GET', '/api/plugins/acme/items')).toMatchObject({ cls: 'leader', away: 'needs-leader', why: 'plugins_need_mac' })
    expect(classify('POST', '/api/plugins/acme/items')).toMatchObject({ cls: 'leader', away: 'needs-leader' })
  })

  it('a path is decoded and its double slashes folded before matching (no way around a row)', () => {
    expect(classify('PATCH', '/api/v1//tasks/t1')).toMatchObject({ why: 'task_writes_need_mac' })
    expect(classify('PATCH', '/api/v1/%74asks/t1')).toMatchObject({ why: 'task_writes_need_mac' })
    expect(classify('GET', '/api/plugins/%zz')).toMatchObject({ why: 'plugins_need_mac' })
  })

  it('the first matching row decides', () => {
    const table: RouteRow[] = [
      { method: 'GET', pattern: '/api/x/:id', cls: 'local' },
      { method: '*', pattern: '/api/*', away: 'needs-leader', why: 'later' },
    ]
    expect(classify('GET', '/api/x/1', table)).toMatchObject({ cls: 'local', away: 'read' })
    expect(classify('GET', '/api/y', table)).toMatchObject({ cls: 'leader', away: 'needs-leader', why: 'later' })
  })
})

describe('the table itself', () => {
  it('journals nothing yet: no host-write, queue or note-write row before WP10 and WP11', () => {
    expect(ROUTE_TABLE.filter((r) => journals(r.away))).toEqual([])
    expect(journals('queue:task-fields')).toBe(true)
    expect(journals('note-write')).toBe(true)
    expect(journals('read')).toBe(false)
  })

  it('every row is well formed: a known method, a path pattern, a known class and away', () => {
    for (const r of ROUTE_TABLE) {
      expect(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'WRITE', '*']).toContain(r.method)
      expect(r.pattern.startsWith('/')).toBe(true)
      if (r.cls) expect(['local', 'feature', 'leader']).toContain(r.cls)
      if (r.away) expect(r.away === 'read' || r.away === 'needs-leader' || journals(r.away)).toBe(true)
    }
  })
})

describe('local rows (WP6)', () => {
  it('a host session\'s history, transcript and changes, a file of a host, and health are local; their condition is on the row', () => {
    for (const p of ['/api/sessions/s1/history', '/api/sessions/s1/subagent/a1/history', '/api/sessions/s1/changes', '/api/sessions/s1/changes/file', '/api/v1/sessions/s1/history', '/api/v1/sessions/s1/transcript', '/api/v1/sessions/s1/changes', '/api/v1/sessions/s1/subagent/a1/history']) {
      const d = classify('GET', p)
      expect(d, p).toMatchObject({ cls: 'local', away: 'read' })
      expect(d.row?.local, p).toBe('session')
    }
    // The changes view is local only when the daemon computes it host-local.
    for (const p of ['/api/sessions/s1/changes', '/api/sessions/s1/changes/file', '/api/v1/sessions/s1/changes']) expect(classify('GET', p).row?.cap, p).toBe('changes-v1')
    for (const p of ['/api/sessions/s1/history', '/api/v1/sessions/s1/transcript', '/api/file-content']) expect(classify('GET', p).row?.cap, p).toBeUndefined()
    for (const p of ['/api/file-content', '/api/files/list', '/api/files/resolve-path', '/api/files/references', '/api/v1/file-content', '/api/v1/files/list', '/api/v1/files/resolve-path']) {
      expect(classify('GET', p).row?.local, p).toBe('host')
      // Not this host's file (no host, or another one): the Mac's, and while it is away nobody's here.
      expect(classify('GET', p), p).toMatchObject({ cls: 'local', away: 'needs-leader', why: 'files_need_mac' })
    }
    for (const p of ['/api/file-raw/devbox/etc/hosts', '/api/file-history', '/api/file-history/version', '/api/local-image', '/api/v1/file-raw/devbox/etc/hosts', '/api/v1/file-raw/local/etc/hosts', '/api/sessions/list-dirs', '/api/v1/sessions/list-dirs']) {
      expect(classify('GET', p), p).toMatchObject({ cls: 'leader', away: 'needs-leader', why: 'files_need_mac' })
    }
    expect(classify('GET', '/api/health')).toMatchObject({ cls: 'local' })
    expect(classify('GET', '/api/health').row?.local).toBeUndefined()
  })

  it('file writes, git commits and the terminal stay the Mac\'s', () => {
    for (const [m, p] of [['PUT', '/api/file-content'], ['POST', '/api/files/rename'], ['POST', '/api/sessions/s1/commit'], ['POST', '/api/sessions/s1/changes/file']]) {
      expect(classify(m!, p!), `${m} ${p}`).toMatchObject({ cls: 'leader', away: 'needs-leader' })
    }
    expect(classify('GET', '/api/sessions/s1/changes/summary').cls).toBe('leader')
  })
})
