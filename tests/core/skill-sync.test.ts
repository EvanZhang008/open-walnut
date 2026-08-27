/**
 * Walnut skill distribution (skills.sync) — hub payload + daemon twin writes.
 *
 * Hand-started sessions get the `walnut` COMMAND from the user-PATH shim but
 * nothing tells the MODEL it exists, so the hub pushes the walnut skill on
 * every daemon connect. v2 layout: ONE real copy per host at
 * ~/.open-walnut/distributed-skills/walnut/SKILL.md (NOT the user's skill
 * store ~/.open-walnut/skills/ — a flat SKILL.md there shadows category
 * sub-skills), and the engines' native skill folders (~/.claude/skills,
 * ~/.agents/skills — codex's documented user-level dir; both follow symlinks)
 * each hold a `walnut` symlink at it. The copy is READ-ONLY (banner says so —
 * updating Walnut is the only way to change it) and every path is
 * marker-guarded (a foreign file is never clobbered; a dir holding anything
 * beyond our SKILL.md is never deleted). v2 also migrates the v1 layout (real
 * claude file, fenced codex AGENTS.md section) and the short-lived v2.0
 * canonical. The daemon-side function is extracted from the deployed node
 * twin and RUN against a temp HOME.
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

  it('is idempotent — already-bannered content never stacks a second banner', () => {
    const once = withReadOnlyBanner('---\nname: walnut\n---\n# Body\n')
    expect(withReadOnlyBanner(once)).toBe(once)
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
const PAYLOAD = { hash: 'h1', skill: SKILL }

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

const canonicalDir = () => path.join(tmp, '.open-walnut', 'distributed-skills', 'walnut')
const legacyCanonicalDir = () => path.join(tmp, '.open-walnut', 'skills', 'walnut')
const canonical = () => path.join(canonicalDir(), 'SKILL.md')
const claudeLink = () => path.join(tmp, '.claude', 'skills', 'walnut')
const agentsLink = () => path.join(tmp, '.agents', 'skills', 'walnut')
const codexAgentsMd = () => path.join(tmp, '.codex', 'AGENTS.md')
const run = (cmd: Record<string, unknown> = PAYLOAD) => cmdSkillsSync(tmp, '/tmp/open-walnut', '/tmp/open-walnut', cmd)

describe('node twin cmdSkillsSync (v2: canonical copy + engine symlinks)', () => {
  it('fresh install: canonical file + claude symlink; no ~/.codex → no ~/.agents', () => {
    const r = run()
    expect(r.ok).toBe(true)
    expect(r.changed).toBe(true)
    expect(fs.readFileSync(canonical(), 'utf-8')).toBe(SKILL)
    expect(fs.lstatSync(claudeLink()).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(claudeLink(), 'SKILL.md'), 'utf-8')).toBe(SKILL)
    expect(fs.existsSync(path.join(tmp, '.agents'))).toBe(false)
    expect(fs.existsSync(path.join(tmp, '.codex'))).toBe(false)
  })

  it('with ~/.codex present, also links ~/.agents/skills/walnut', () => {
    fs.mkdirSync(path.join(tmp, '.codex'), { recursive: true })
    run()
    expect(fs.lstatSync(agentsLink()).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(agentsLink(), 'SKILL.md'), 'utf-8')).toBe(SKILL)
  })

  it('~/.agents/skills already a symlink to ~/.claude/skills (shared layout): no duplicate work, no error', () => {
    fs.mkdirSync(path.join(tmp, '.codex'), { recursive: true })
    fs.mkdirSync(path.join(tmp, '.claude', 'skills'), { recursive: true })
    fs.mkdirSync(path.join(tmp, '.agents'), { recursive: true })
    fs.symlinkSync(path.join(tmp, '.claude', 'skills'), path.join(tmp, '.agents', 'skills'))
    const r = run()
    expect(r.ok).toBe(true)
    // both engine paths resolve to the canonical dir through ONE link
    expect(fs.realpathSync(claudeLink())).toBe(fs.realpathSync(canonicalDir()))
    expect(fs.realpathSync(agentsLink())).toBe(fs.realpathSync(canonicalDir()))
    expect((r.wrote ?? []).filter((w) => w.endsWith('walnut') && !w.includes('.open-walnut')).length).toBe(1)
  })

  it('re-push with identical content is a no-op (changed:false)', () => {
    run()
    const r = run()
    expect(r.changed).toBe(false)
  })

  it('content update rewrites the canonical file; links stay put', () => {
    run()
    const r = run({ hash: 'h2', skill: SKILL + 'v2\n' })
    expect(r.changed).toBe(true)
    expect(fs.readFileSync(canonical(), 'utf-8')).toContain('v2')
    expect(fs.readFileSync(path.join(claudeLink(), 'SKILL.md'), 'utf-8')).toContain('v2')
  })

  it('never clobbers a foreign canonical SKILL.md (no marker)', () => {
    fs.mkdirSync(canonicalDir(), { recursive: true })
    fs.writeFileSync(canonical(), '# my own walnut notes\n')
    run()
    expect(fs.readFileSync(canonical(), 'utf-8')).toBe('# my own walnut notes\n')
  })

  it('leaves a foreign ~/.claude/skills/walnut dir alone (no marker)', () => {
    fs.mkdirSync(claudeLink(), { recursive: true })
    fs.writeFileSync(path.join(claudeLink(), 'SKILL.md'), '# hand-made\n')
    run()
    expect(fs.lstatSync(claudeLink()).isDirectory()).toBe(true)
    expect(fs.readFileSync(path.join(claudeLink(), 'SKILL.md'), 'utf-8')).toBe('# hand-made\n')
  })

  it('migrates the v1 layout: owned real dir → symlink; AGENTS.md fence removed, user content intact', () => {
    // v1 claude copy (real dir, marker present)
    fs.mkdirSync(claudeLink(), { recursive: true })
    fs.writeFileSync(path.join(claudeLink(), 'SKILL.md'), SKILL)
    // v1 codex fence appended after user content
    fs.mkdirSync(path.join(tmp, '.codex'), { recursive: true })
    fs.writeFileSync(codexAgentsMd(), `# User rules\nalways be nice\n\n${CODEX_BEGIN}\n## Walnut\nrun walnut guide\n${CODEX_END}\n`)
    const r = run()
    expect(r.ok).toBe(true)
    expect(fs.lstatSync(claudeLink()).isSymbolicLink()).toBe(true)
    expect(fs.realpathSync(claudeLink())).toBe(fs.realpathSync(canonicalDir()))
    const md = fs.readFileSync(codexAgentsMd(), 'utf-8')
    expect(md).toContain('# User rules\nalways be nice')
    expect(md).not.toContain(CODEX_BEGIN)
    expect(md).not.toContain('run walnut guide')
  })

  it('removes a fence-only AGENTS.md whole (v1 created it, nothing of the user in it)', () => {
    fs.mkdirSync(path.join(tmp, '.codex'), { recursive: true })
    fs.writeFileSync(codexAgentsMd(), `${CODEX_BEGIN}\n## Walnut\nrun walnut guide\n${CODEX_END}\n`)
    run()
    expect(fs.existsSync(codexAgentsMd())).toBe(false)
  })

  it('NEVER deletes a dir holding user entries next to our marker\'d SKILL.md — refreshes the file in place', () => {
    fs.mkdirSync(path.join(claudeLink(), 'my-sub-skill'), { recursive: true })
    fs.writeFileSync(path.join(claudeLink(), 'my-sub-skill', 'SKILL.md'), '# user sub-skill\n')
    fs.writeFileSync(path.join(claudeLink(), 'SKILL.md'), SKILL)
    const r = run({ hash: 'h2', skill: SKILL + 'v2\n' })
    expect(r.ok).toBe(true)
    expect(fs.lstatSync(claudeLink()).isDirectory()).toBe(true)
    expect(fs.readFileSync(path.join(claudeLink(), 'my-sub-skill', 'SKILL.md'), 'utf-8')).toBe('# user sub-skill\n')
    expect(fs.readFileSync(path.join(claudeLink(), 'SKILL.md'), 'utf-8')).toContain('v2')
  })

  it('v2.0 migration: removes only our SKILL.md from the user skill store, keeps sub-skill dirs; retargets old links', () => {
    // v2.0 state: canonical inside ~/.open-walnut/skills/walnut (marker'd
    // SKILL.md next to the user's category sub-skills), engine link at it
    fs.mkdirSync(path.join(legacyCanonicalDir(), 'legacy-sub'), { recursive: true })
    fs.writeFileSync(path.join(legacyCanonicalDir(), 'legacy-sub', 'SKILL.md'), '# legacy sub-skill\n')
    fs.writeFileSync(path.join(legacyCanonicalDir(), 'SKILL.md'), SKILL)
    fs.mkdirSync(path.join(tmp, '.claude', 'skills'), { recursive: true })
    fs.symlinkSync(legacyCanonicalDir(), claudeLink())
    const r = run()
    expect(r.ok).toBe(true)
    expect(fs.realpathSync(claudeLink())).toBe(fs.realpathSync(canonicalDir()))
    expect(fs.existsSync(path.join(legacyCanonicalDir(), 'SKILL.md'))).toBe(false)
    expect(fs.readFileSync(path.join(legacyCanonicalDir(), 'legacy-sub', 'SKILL.md'), 'utf-8')).toBe('# legacy sub-skill\n')
  })

  it('v2.0 migration: a store dir we solely owned is removed whole', () => {
    fs.mkdirSync(legacyCanonicalDir(), { recursive: true })
    fs.writeFileSync(path.join(legacyCanonicalDir(), 'SKILL.md'), SKILL)
    run()
    expect(fs.existsSync(legacyCanonicalDir())).toBe(false)
  })

  it('v2.0 migration: a foreign SKILL.md in the user skill store stays', () => {
    fs.mkdirSync(legacyCanonicalDir(), { recursive: true })
    fs.writeFileSync(path.join(legacyCanonicalDir(), 'SKILL.md'), '# the user\'s own walnut skill\n')
    run()
    expect(fs.readFileSync(path.join(legacyCanonicalDir(), 'SKILL.md'), 'utf-8')).toBe('# the user\'s own walnut skill\n')
  })

  it('a non-production daemon never touches the user home', () => {
    const r = cmdSkillsSync(tmp, path.join(tmp, 'sandbox-daemon'), '/tmp/open-walnut', PAYLOAD)
    expect(r.skipped).toBe('non-prod')
    expect(fs.existsSync(canonical())).toBe(false)
    expect(fs.existsSync(claudeLink())).toBe(false)
  })

  it('rejects a payload without the managed marker', () => {
    const r = run({ hash: 'x', skill: '# no marker here\n' })
    expect(r.ok).toBe(false)
    expect(fs.existsSync(canonical())).toBe(false)
  })
})

describe('twin parity', () => {
  it('the bun twin carries the same handler, layout and guards', () => {
    const standalone = fs.readFileSync(path.join(ROOT, 'src/providers/daemon-standalone.ts'), 'utf-8')
    expect(standalone).toContain("case 'skills.sync': return cmdSkillsSync")
    expect(standalone).toContain("SKILL_SYNC_MARKER = 'walnut-managed v1'")
    expect(standalone).toContain("path.join(HOME_DIR, '.open-walnut', 'distributed-skills', 'walnut')")
    expect(standalone).toContain("path.join(HOME_DIR, '.open-walnut', 'skills', 'walnut')")
    expect(standalone).toContain("ensureLink(path.join(HOME_DIR, '.claude', 'skills'))")
    expect(standalone).toContain("if (fs.existsSync(path.join(HOME_DIR, '.codex'))) ensureLink(path.join(HOME_DIR, '.agents', 'skills'))")
    expect(standalone).toContain('fs.symlinkSync(canonicalDir, link)')
    expect(standalone).toMatch(/skills\.sync[\s\S]{0,2600}PROD_DAEMON_DIR\)\) \{\s*\n\s*return sendOk\(ws, id, \{ applied: true, changed: false, skipped: 'non-prod' \}\)/)
  })
})
