// How a session's servers are named in its Web view (web/src/components/sessions/session-server-label.ts).
import { describe, expect, it } from 'vitest'
import { formatAge, serverLabel, serversSummary, serverAge, serverStartedAt, shortCommand } from '../../web/src/components/sessions/session-server-label'

describe('serverLabel', () => {
  const cases: Array<[string, string, string]> = [
    ['node', 'node /w/app/node_modules/.bin/vite --port 5173', 'vite'],
    ['node', 'node /w/app/node_modules/vite/bin/vite.js --port 5173', 'vite'],
    ['node', 'node server.js', 'server'],
    ['bun', '/home/u/.bun/bin/bun ro-proxy.ts', 'ro-proxy'],
    ['python3', 'python3 -m http.server 8000', 'http.server'],
    ['python3', 'python3 -c import http.server, sys', 'python3'],
    ['node', 'node -e require("http").createServer().listen(1)', 'node'],
    ['next-server', 'next-server (v15.0.0)', 'next-server'],
    ['postgres', '/usr/lib/postgresql/16/bin/postgres -D /var/lib/pg', 'postgres'],
    ['', '', 'server'],
  ]
  for (const [name, command, want] of cases) {
    it(`${command || '(empty)'} -> ${want}`, () => expect(serverLabel({ name, command })).toBe(want))
  }
})

describe('formatAge', () => {
  it('reads as seconds, minutes, hours, days', () => {
    expect([formatAge(null), formatAge(-1), formatAge(42), formatAge(125), formatAge(7300), formatAge(200_000)]).toEqual(['', '', '42s', '2m', '2h', '2d'])
  })
})

describe('shortCommand', () => {
  it('keeps the arguments in view by cutting long paths', () => {
    expect(shortCommand('node /home/u/work/app/node_modules/vite/bin/vite.js --port 5173')).toBe('node …/vite/bin/vite.js --port 5173')
    expect(shortCommand('/usr/lib/postgresql/16/bin/postgres -D /var/lib/pg')).toBe('…/bin/postgres -D …/lib/pg')
    expect(shortCommand('python3 -m http.server 8000')).toBe('python3 -m http.server 8000')
    expect(shortCommand('/bin/sh /a/b')).toBe('/bin/sh /a/b')
  })
  it('reads inline code by its first words', () => {
    expect(shortCommand('python3 -c import socket s=socket.socket(); s.bind(("127.0.0.1", 6379))')).toBe('python3 -c "import socket s=socket.socket(); s.bind(("127.0.0.1", 6379))"')
    expect(shortCommand(`node -e ${'x'.repeat(100)}`)).toBe(`node -e "${'x'.repeat(72)}…"`)
    expect(shortCommand('node -e require("http")')).toBe('node -e "require("http")"')
    expect(shortCommand('/usr/local/bin/python3 -c print(1)')).toBe('…/bin/python3 -c "print(1)"')
    // As the host sends it: shell-quoted, with the script's own newlines.
    // A line break shows as a return mark (U+23CE).
    expect(shortCommand("python3 -c 'import sys\nprint(1)'")).toBe('python3 -c "import sys \u23CE print(1)"')
    expect(shortCommand("python3 -c 'import socket\ns=socket.socket()'")).toBe('python3 -c "import socket \u23CE s=socket.socket()"')
    expect(shortCommand('')).toBe('')
  })
})

describe('serversSummary', () => {
  it('counts web servers first, else the others, else nothing', () => {
    const web = { kind: 'http' }, tls = { kind: 'https' }, raw = { kind: 'other' }
    expect(serversSummary([web, tls, raw])).toBe('2 web servers')
    expect(serversSummary([web])).toBe('1 web server')
    // Only a database runs: the menu must not read "none running".
    expect(serversSummary([raw])).toBe('1 other server')
    expect(serversSummary([raw, raw])).toBe('2 other servers')
    expect(serversSummary([])).toBeNull()
  })
})

describe('serverAge', () => {
  it('counts from the start stamped when the list arrived, however old the list is', () => {
    const now = 1_000_000
    // Listed 60 s ago at 5 s old: it has run 65 s, not the 5 s the list said.
    expect(serverAge({ ageSec: 5, startedAtMs: now - 65_000 }, now)).toBe(65)
    expect(serverStartedAt({ ageSec: 5, startedAtMs: now - 65_000 }, now)).toBe(now - 65_000)
    // No stamp (a list from before this tab stamped it): from ageSec now.
    expect(serverAge({ ageSec: 12 }, now)).toBe(12)
    expect(serverAge({ ageSec: null }, now)).toBeNull()
    expect(serverAge({ ageSec: null, startedAtMs: null }, now)).toBeNull()
  })
})
