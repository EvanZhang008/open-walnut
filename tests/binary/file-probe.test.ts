/**
 * Asking a compiled Walnut file what it is (`<file> __daemon --version`, `__daemon --service-roles`)
 * never unpacks it (2026-11-24 drill L1: a service set's update asked its new file with no env, the
 * file unpacked its whole runtime into the other Walnut's ~/.open-walnut/local/runtime and pruned
 * there). runtime-root.ts answers those probes from build constants before ensureRuntime.
 *
 * Guard for the class: every flag Walnut's code asks a file with (daemonFileSays, daemonFileAnswer,
 * createServiceRolesReader in src/) must be one fileProbeOf answers before the unpack.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileProbeOf } from '../../src/binary/runtime-tree.js'
import { SERVICE_ROLES_FLAG } from '../../src/providers/service-roles.js'

const ROOT = path.resolve(__dirname, '../..')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

describe('a probe of the walnut file is answered before it unpacks', () => {
  it.each([
    [['bun', '/f', '__daemon', '--version'], '--version'],
    [['bun', '/f', '__daemon', '--service-roles'], '--service-roles'],
    [['/f', '/f', '/f', '__daemon', '--version'], '--version'],
    [['bun', '/f', '__daemon', '--version', 'x'], null],
    [['bun', '/f', '--version'], null],
    [['bun', '/f', '__daemon', '--start'], null],
    [['bun', '/f', 'walnut', '__daemon', '--version'], null],
  ] as const)('fileProbeOf(%j) is %s', (argv, want) => {
    expect(fileProbeOf(argv, '/f')).toBe(want)
  })

  it('the runtime root answers it before ensureRuntime, with what the daemon program prints', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/binary/runtime-root.ts'), 'utf8')
    const probe = src.indexOf('fileProbeOf(process.argv, process.execPath)')
    expect(probe).toBeGreaterThan(0)
    expect(probe).toBeLessThan(src.indexOf('= ensureRuntime('))
    expect(src).toMatch(/probe === '--version' \? DAEMON_VERSION : SERVICE_ROLES\.join\(' '\)/)
    const daemon = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf8')
    expect(daemon).toMatch(/console\.log\(programServiceRoles\(singleFile\(\) !== null\)\.join\(' '\)\)/)
  })

  it('every flag a Walnut asks a file with is one the file answers before it unpacks', () => {
    const asks: string[] = []
    for (const file of walk(path.join(ROOT, 'src'))) {
      const text = fs.readFileSync(file, 'utf8')
      for (const m of text.matchAll(/\b(?:daemonFileSays|daemonFileAnswer)\(\s*[^,]+,\s*([^,)]+)/g)) {
        if (/export (?:async )?function/.test(text.slice(Math.max(0, m.index! - 40), m.index!))) continue
        asks.push(`${path.relative(ROOT, file)}: ${m[1]!.trim()}`)
      }
    }
    expect(asks.length).toBeGreaterThanOrEqual(3)
    const flagOf = (expr: string) => (expr === 'SERVICE_ROLES_FLAG' ? SERVICE_ROLES_FLAG : expr === 'flag' ? null : expr.replace(/^'|'$/g, ''))
    const unanswered = asks.filter((a) => {
      const flag = flagOf(a.split(': ')[1]!)
      return flag !== null && fileProbeOf(['bun', '/f', '__daemon', flag], '/f') === null
    })
    expect(unanswered, 'a new probe flag: answer it in runtime-tree.ts fileProbeOf (before the unpack), or ask it with the asker\'s runtime env').toEqual([])
  })
})
