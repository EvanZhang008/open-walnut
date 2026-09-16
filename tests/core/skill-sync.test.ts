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
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import crypto from 'node:crypto'
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
const geminiLink = () => path.join(tmp, '.gemini', 'skills', 'walnut')
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

  afterEach(() => vi.unstubAllEnvs())

  it.each([false, true])('links Pi skills with a redirected agent directory: %s', (redirected) => {
    const agentDir = path.join(tmp, redirected ? 'pi-custom' : '.pi/agent')
    vi.stubEnv('PI_CODING_AGENT_DIR', redirected ? agentDir : '')
    fs.mkdirSync(agentDir, { recursive: true })
    expect(run().ok).toBe(true)
    expect(fs.realpathSync(agentsLink())).toBe(fs.realpathSync(canonicalDir()))
  })

  it('with ~/.codex present, also links ~/.agents/skills/walnut', () => {
    fs.mkdirSync(path.join(tmp, '.codex'), { recursive: true })
    run()
    expect(fs.lstatSync(agentsLink()).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(agentsLink(), 'SKILL.md'), 'utf-8')).toBe(SKILL)
  })

  // goose reads ~/.agents/skills like codex does, but its presence marker is a
  // config dir, and either of the two documented ones must be enough.
  for (const gooseDir of [['.config', 'goose'], ['.local', 'share', 'goose']]) {
    it(`with ~/${gooseDir.join('/')} present, links ~/.agents/skills/walnut`, () => {
      fs.mkdirSync(path.join(tmp, ...gooseDir), { recursive: true })
      const r = run()
      expect(r.ok).toBe(true)
      expect(fs.lstatSync(agentsLink()).isSymbolicLink()).toBe(true)
      expect(fs.readFileSync(path.join(agentsLink(), 'SKILL.md'), 'utf-8')).toBe(SKILL)
      // goose alone must not conjure a codex/gemini dir.
      expect(fs.existsSync(path.join(tmp, '.gemini'))).toBe(false)
      expect(fs.existsSync(path.join(tmp, '.codex'))).toBe(false)
    })
  }

  it('with ~/.gemini present, links ~/.gemini/skills/walnut (gemini shares no dir)', () => {
    fs.mkdirSync(path.join(tmp, '.gemini'), { recursive: true })
    const r = run()
    expect(r.ok).toBe(true)
    expect(fs.lstatSync(geminiLink()).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(geminiLink(), 'SKILL.md'), 'utf-8')).toBe(SKILL)
    // gemini discovers ONLY its own dir, so it must not pull in ~/.agents.
    expect(fs.existsSync(path.join(tmp, '.agents'))).toBe(false)
  })

  it('a host running codex + goose + gemini gets ONE ~/.agents link plus the gemini one', () => {
    fs.mkdirSync(path.join(tmp, '.codex'), { recursive: true })
    fs.mkdirSync(path.join(tmp, '.config', 'goose'), { recursive: true })
    fs.mkdirSync(path.join(tmp, '.gemini'), { recursive: true })
    const r = run()
    expect(r.ok).toBe(true)
    for (const link of [claudeLink(), agentsLink(), geminiLink()]) {
      expect(fs.realpathSync(link)).toBe(fs.realpathSync(canonicalDir()))
    }
    // The codex and goose guards both target ~/.agents/skills; the second call
    // must be an idempotent no-op, not a second write.
    expect((r.wrote ?? []).filter((w) => w === agentsLink()).length).toBe(1)
  })

  it('no engine dirs at all: only the claude link, nothing invented', () => {
    const r = run()
    expect(r.ok).toBe(true)
    expect(fs.lstatSync(claudeLink()).isSymbolicLink()).toBe(true)
    for (const d of ['.agents', '.gemini', '.codex']) {
      expect(fs.existsSync(path.join(tmp, d))).toBe(false)
    }
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

// The engines discover a slash command by SKILL DIRECTORY name, so every skill
// walnut wants reachable from a hand-started session needs its own canonical
// copy and its own per-engine link — one payload, N entries.
describe('node twin cmdSkillsSync (multiple skills in one payload)', () => {
  const TRIGGER_SKILL = `---\nname: walnut-trigger\n---\n<!-- ${DISTRIBUTED_MARKER} — READ-ONLY -->\n# Trigger manual\n`
  const dirFor = (name: string) => path.join(tmp, '.open-walnut', 'distributed-skills', name)
  const linkFor = (name: string) => path.join(tmp, '.claude', 'skills', name)

  it('writes one canonical copy and one claude link per entry', () => {
    const r = run({ hash: 'h2', skills: [{ name: 'walnut', skill: SKILL }, { name: 'walnut-trigger', skill: TRIGGER_SKILL }] })
    expect(r.ok).toBe(true)
    expect(r.changed).toBe(true)
    expect(fs.readFileSync(path.join(dirFor('walnut'), 'SKILL.md'), 'utf-8')).toBe(SKILL)
    expect(fs.readFileSync(path.join(dirFor('walnut-trigger'), 'SKILL.md'), 'utf-8')).toBe(TRIGGER_SKILL)
    for (const name of ['walnut', 'walnut-trigger']) {
      expect(fs.lstatSync(linkFor(name)).isSymbolicLink()).toBe(true)
      expect(fs.realpathSync(linkFor(name))).toBe(fs.realpathSync(dirFor(name)))
    }
    // Each link resolves to its OWN skill, not to the first entry's copy.
    expect(fs.readFileSync(path.join(linkFor('walnut-trigger'), 'SKILL.md'), 'utf-8')).toBe(TRIGGER_SKILL)
  })

  it('re-push of the same two entries is a no-op (changed:false)', () => {
    const payload = { hash: 'h2', skills: [{ name: 'walnut', skill: SKILL }, { name: 'walnut-trigger', skill: TRIGGER_SKILL }] }
    expect(run(payload).changed).toBe(true)
    expect(run(payload).changed).toBe(false)
  })

  it('an updated second skill rewrites only its own canonical file', () => {
    run({ skills: [{ name: 'walnut', skill: SKILL }, { name: 'walnut-trigger', skill: TRIGGER_SKILL }] })
    const next = TRIGGER_SKILL + '# more\n'
    const r = run({ skills: [{ name: 'walnut', skill: SKILL }, { name: 'walnut-trigger', skill: next }] })
    expect(r.wrote).toEqual([path.join(dirFor('walnut-trigger'), 'SKILL.md')])
    expect(fs.readFileSync(path.join(dirFor('walnut'), 'SKILL.md'), 'utf-8')).toBe(SKILL)
  })

  it('the legacy bare skill payload still means the walnut skill alone', () => {
    const r = run({ hash: 'h1', skill: SKILL })
    expect(r.ok).toBe(true)
    expect(fs.existsSync(path.join(dirFor('walnut'), 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(dirFor('walnut-trigger'))).toBe(false)
  })

  // A name becomes a directory and a symlink under the user's HOME: one bad
  // entry rejects the WHOLE payload, before any path is built.
  it.each(['../escape', 'Walnut', 'walnut/trigger', '', '-lead'])('refuses the whole payload for an invalid name: %j', (name) => {
    const r = run({ skills: [{ name: 'walnut', skill: SKILL }, { name, skill: SKILL }] })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('invalid skill name')
    expect(fs.existsSync(dirFor('walnut'))).toBe(false)
  })

  it('one entry missing the managed marker rejects the whole payload', () => {
    const r = run({ skills: [{ name: 'walnut', skill: SKILL }, { name: 'walnut-trigger', skill: '# no marker\n' }] })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('managed marker')
    expect(fs.existsSync(dirFor('walnut'))).toBe(false)
  })
})

// The hub side of the same payload: WHICH skills every host gets, and a hash
// that changes when the set changes (not just when a body is edited).
describe('buildSkillSyncPayload', () => {
  it('ships walnut AND walnut-trigger, bannered, sorted, with the legacy field intact', async () => {
    const { buildSkillSyncPayload, DISTRIBUTED_SKILL_NAMES } = await import('../../src/core/skill-sync.js')
    const payload = await buildSkillSyncPayload()
    expect(payload).not.toBeNull()
    expect(payload!.skills.map((s) => s.name)).toEqual([...DISTRIBUTED_SKILL_NAMES].sort())
    for (const entry of payload!.skills) {
      expect(entry.skill, `${entry.name} carries the managed marker`).toContain(DISTRIBUTED_MARKER)
      expect(entry.skill.startsWith('---\n'), `${entry.name} keeps valid frontmatter`).toBe(true)
    }
    // A daemon too old for `skills` reads `skill` alone and must still get walnut.
    expect(payload!.skill).toBe(payload!.skills.find((s) => s.name === 'walnut')!.skill)
    // walnut-trigger is the reason this exists: an engine lists a slash command
    // by skill DIRECTORY name, so the trigger skill needs its own entry.
    expect(payload!.skills.some((s) => s.name === 'walnut-trigger')).toBe(true)
    expect(payload!.hash).toHaveLength(16)
  })

  it('the hash covers the NAMES too, so adding or renaming a skill reaches the host', async () => {
    const { buildSkillSyncPayload } = await import('../../src/core/skill-sync.js')
    const payload = await buildSkillSyncPayload()
    const again = await buildSkillSyncPayload()
    expect(again!.hash).toBe(payload!.hash)

    // Same bodies, different name → a different hash (a hash over contents
    // alone would skip the push that renames a slash command).
    const hashOf = (entries: Array<{ name: string; skill: string }>) => crypto
      .createHash('sha256').update(JSON.stringify(entries.map((e) => [e.name, e.skill])))
      .digest('hex').slice(0, 16)
    const renamed = payload!.skills.map((s) => (s.name === 'walnut-trigger' ? { ...s, name: 'walnut-watch' } : s))
    expect(hashOf(renamed)).not.toBe(payload!.hash)
    expect(hashOf(payload!.skills)).toBe(payload!.hash)
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
    // goose: either documented config dir marks it, and it shares codex's dir.
    expect(standalone).toContain("fs.existsSync(path.join(HOME_DIR, '.config', 'goose')) || fs.existsSync(path.join(HOME_DIR, '.local', 'share', 'goose'))")
    // gemini: the one engine with a private skills dir.
    expect(standalone).toContain("if (fs.existsSync(path.join(HOME_DIR, '.gemini'))) ensureLink(path.join(HOME_DIR, '.gemini', 'skills'))")
    expect(standalone).toContain('fs.symlinkSync(canonicalDir, link)')
    expect(standalone).toMatch(/skills\.sync[\s\S]{0,2600}PROD_DAEMON_DIR\)\) \{\s*\n\s*return sendOk\(ws, id, \{ applied: true, changed: false, skipped: 'non-prod' \}\)/)
  })
})
