/**
 * Walnut skill distribution (skills.sync) — hub payload + daemon twin writes.
 *
 * Hand-started sessions get the `walnut` COMMAND from the user-PATH shim but
 * nothing tells the MODEL it exists, so the hub pushes the walnut skill on
 * every daemon connect and the daemon writes it into each engine's native
 * discovery surface: ~/.claude/skills/walnut/SKILL.md and a fenced section in
 * ~/.codex/AGENTS.md. The distributed copies are READ-ONLY (banner says so —
 * updating Walnut is the only way to change them) and marker-guarded (a
 * foreign file is never clobbered). The daemon-side function is extracted
 * from the deployed node twin and RUN against a temp HOME.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { withReadOnlyBanner, CODEX_BEGIN, CODEX_END, DISTRIBUTED_MARKER } from '../../src/core/skill-sync.js'

const ROOT = path.resolve(__dirname, '../..')

describe('withReadOnlyBanner', () => {
  it('injects the read-only banner AFTER frontmatter, keeping it valid', () => {
    const md = '---\nname: walnut\ndescription: x\n---\n\n# Body\n'
    const out = withReadOnlyBanner(md)
    expect(out.startsWith('---\nname: walnut')).toBe(true)
    expect(out).toContain(DISTRIBUTED_MARKER)
    expect(out).toContain('READ-ONLY')
    expect(out).toContain('update Walnut itself')
    expect(out.indexOf(DISTRIBUTED_MARKER)).toBeGreaterThan(out.indexOf('---\n', 4))
    expect(out).toContain('# Body')
  })

  it('prepends the banner when there is no frontmatter', () => {
    const out = withReadOnlyBanner('# Plain\n')
    expect(out.startsWith('<!-- ' + DISTRIBUTED_MARKER)).toBe(true)
    expect(out).toContain('# Plain')
  })
})

// ── the node twin's cmdSkillsSync, actually run against a temp HOME ──

type Reply = { ok?: boolean; changed?: boolean; skipped?: string; wrote?: string[]; error?: string }

function extractCmdSkillsSync(): (homeDir: string, daemonDir: string, prodDir: string, cmd: Record<string, unknown>) => Reply {
  const src = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-source.ts'), 'utf-8')
  const start = src.indexOf('const DAEMON_SOURCE = `')
  expect(start).toBeGreaterThan(-1)
  const body = src.slice(src.indexOf('`', start) + 1, src.lastIndexOf('`'))
  // eslint-disable-next-line no-eval
  const twin = eval('`' + body + '`') as string
  const fnStart = twin.indexOf('function cmdSkillsSync(')
  expect(fnStart).toBeGreaterThan(-1)
  const fnEnd = twin.indexOf('\n}', fnStart)
  const fnSrc = twin.slice(fnStart, fnEnd + 2)
  return (homeDir, daemonDir, prodDir, cmd) => {
    let reply: Reply = {}
    const sendOk = (_ws: unknown, _id: unknown, data: Reply) => { reply = { ok: true, ...data } }
    const sendError = (_ws: unknown, _id: unknown, error: string) => { reply = { ok: false, error } }
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const bound = new Function(
      'path', 'fs', 'HOME_DIR', 'DAEMON_DIR', 'PROD_DAEMON_DIR', 'sendOk', 'sendError', 'logMsg', 'SKILL_SYNC_MARKER', 'CMD',
      fnSrc + '\nreturn cmdSkillsSync(null, 1, CMD);',
    ) as (...a: unknown[]) => void
    bound(path, fs, homeDir, daemonDir, prodDir, sendOk, sendError, () => {}, 'walnut-managed v1', cmd)
    return reply
  }
}

const SKILL = `---\nname: walnut\n---\n<!-- ${DISTRIBUTED_MARKER} — READ-ONLY -->\n# Walnut manual\n`
const SECTION = `${CODEX_BEGIN}\n## Walnut\nrun walnut guide\n${CODEX_END}`
const PAYLOAD = { hash: 'h1', claudeSkill: SKILL, codexSection: SECTION }

let tmp: string
const dirs: string[] = []
const cmdSkillsSync = extractCmdSkillsSync()

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-skill-sync-'))
  dirs.push(tmp)
})

afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

const claudePath = () => path.join(tmp, '.claude', 'skills', 'walnut', 'SKILL.md')
const codexPath = () => path.join(tmp, '.codex', 'AGENTS.md')

describe('node twin cmdSkillsSync', () => {
  it('fresh install writes the claude skill; ~/.codex absent stays absent', () => {
    const r = cmdSkillsSync(tmp, '/tmp/open-walnut', '/tmp/open-walnut', PAYLOAD)
    expect(r.ok).toBe(true)
    expect(r.changed).toBe(true)
    expect(fs.readFileSync(claudePath(), 'utf-8')).toBe(SKILL)
    expect(fs.existsSync(path.join(tmp, '.codex'))).toBe(false)
  })

  it('re-push with identical content is a no-op (changed:false)', () => {
    cmdSkillsSync(tmp, '/tmp/open-walnut', '/tmp/open-walnut', PAYLOAD)
    const r = cmdSkillsSync(tmp, '/tmp/open-walnut', '/tmp/open-walnut', PAYLOAD)
    expect(r.changed).toBe(false)
  })

  it('updates a managed copy when content changes', () => {
    cmdSkillsSync(tmp, '/tmp/open-walnut', '/tmp/open-walnut', PAYLOAD)
    const v2 = { ...PAYLOAD, claudeSkill: SKILL + 'v2\n' }
    const r = cmdSkillsSync(tmp, '/tmp/open-walnut', '/tmp/open-walnut', v2)
    expect(r.changed).toBe(true)
    expect(fs.readFileSync(claudePath(), 'utf-8')).toContain('v2')
  })

  it('never clobbers a foreign SKILL.md (no marker)', () => {
    fs.mkdirSync(path.dirname(claudePath()), { recursive: true })
    fs.writeFileSync(claudePath(), '# my own walnut notes\n')
    const r = cmdSkillsSync(tmp, '/tmp/open-walnut', '/tmp/open-walnut', PAYLOAD)
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(claudePath(), 'utf-8')).toBe('# my own walnut notes\n')
  })

  it('appends a fenced section to an existing ~/.codex/AGENTS.md and replaces it in place on update', () => {
    fs.mkdirSync(path.join(tmp, '.codex'), { recursive: true })
    fs.writeFileSync(codexPath(), '# User rules\nalways be nice\n')
    cmdSkillsSync(tmp, '/tmp/open-walnut', '/tmp/open-walnut', PAYLOAD)
    const first = fs.readFileSync(codexPath(), 'utf-8')
    expect(first).toContain('# User rules\nalways be nice')
    expect(first).toContain(CODEX_BEGIN)
    // update: fenced section replaced, user content intact, no duplication
    const v2 = { ...PAYLOAD, codexSection: `${CODEX_BEGIN}\nNEW BODY\n${CODEX_END}` }
    cmdSkillsSync(tmp, '/tmp/open-walnut', '/tmp/open-walnut', v2)
    const second = fs.readFileSync(codexPath(), 'utf-8')
    expect(second).toContain('NEW BODY')
    expect(second).toContain('# User rules\nalways be nice')
    expect(second.split(CODEX_BEGIN).length).toBe(2) // exactly one fence
    expect(second).not.toContain('run walnut guide')
  })

  it('creates ~/.codex/AGENTS.md when the .codex dir exists without one', () => {
    fs.mkdirSync(path.join(tmp, '.codex'), { recursive: true })
    cmdSkillsSync(tmp, '/tmp/open-walnut', '/tmp/open-walnut', PAYLOAD)
    expect(fs.readFileSync(codexPath(), 'utf-8')).toContain(CODEX_BEGIN)
  })

  it('a non-production daemon never touches the user home', () => {
    const r = cmdSkillsSync(tmp, path.join(tmp, 'sandbox-daemon'), '/tmp/open-walnut', PAYLOAD)
    expect(r.skipped).toBe('non-prod')
    expect(fs.existsSync(claudePath())).toBe(false)
  })

  it('rejects a payload without the managed marker', () => {
    const r = cmdSkillsSync(tmp, '/tmp/open-walnut', '/tmp/open-walnut', { claudeSkill: 'x', codexSection: 'y' })
    expect(r.ok).toBe(false)
    expect(fs.existsSync(claudePath())).toBe(false)
  })
})

describe('twin parity', () => {
  it('the bun twin carries the same handler, guards and marker', () => {
    const standalone = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf-8')
    expect(standalone).toContain("case 'skills.sync': return cmdSkillsSync")
    expect(standalone).toContain("SKILL_SYNC_MARKER = 'walnut-managed v1'")
    expect(standalone).toContain("path.join(HOME_DIR, '.claude', 'skills', 'walnut')")
    expect(standalone).toContain("path.join(HOME_DIR, '.codex')")
    expect(standalone).toMatch(/skills\.sync[\s\S]{0,2000}PROD_DAEMON_DIR\)\) \{\s*\n\s*return sendOk\(ws, id, \{ applied: true, changed: false, skipped: 'non-prod' \}\)/)
  })
})
