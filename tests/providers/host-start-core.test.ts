/**
 * The daemon's start of a new Ask Walnut session while the Mac is away
 * (src/providers/host-start-core.ts, docs/plan/walnut-replica-servers-impl.md WP12).
 *
 * Why: the daemon spawns a real Claude Code CLI on a dev box, and the fields come
 * from the host replica, which runs on that box. No field may reach the argv
 * unchecked: the argv is the Mac's template, and each slot takes one validated value
 * (or none). These run the real core on a temp dir (no daemon, no CLI).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostStart, type HostStart } from '../../src/providers/host-start-core.js'
import { buildHostSpawnTemplate, buildRoutineSpawnTemplate, hostRoutineModes } from '../../src/providers/spawn-template.js'
import { START_TASK_TOKEN } from '../../src/providers/trigger-clock-core.js'

const HOME = '/Users/marina/.open-walnut'
const SID = 'aaaaaaaa-1111-4111-8111-111111111111'
const INJECT = `'; touch /tmp/pwned; echo '\`id\`$(id) --dangerously-skip-permissions`

let dir: string
let now = Date.UTC(2026, 9, 17)
let busy = 0
const logs: Array<{ level: string; msg: string }> = []

function make(): HostStart {
  return createHostStart({
    fs, path, dir, keyOf: () => 'k1', now: () => now,
    log: (level, msg) => { logs.push({ level, msg }) },
    busy: () => busy,
  })
}

function template(o: { bypassAllowed?: boolean; agents?: Record<string, { allowedTools?: string[]; tools?: string[] }> } = {}) {
  return buildHostSpawnTemplate({ home: HOME, hostKey: 'marina', cwd: dir, bypassAllowed: o.bypassAllowed, env: {}, now, ...(o.agents ? { agents: o.agents } : {}) })
}

function fields(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sid: SID, taskId: 'task-ask-1', agentId: 'general', title: 'What is open today',
    persona: { text: '## Persona override\nYou are Walnut.', context: 'You are working on the task "What is open today".' },
    firstMessage: 'what is open today?', ...over,
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-host-start-'))
  now = Date.UTC(2026, 9, 17)
  busy = 0
  logs.length = 0
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('no template', () => {
  it('answers needs_leader no_spawn_template', () => {
    const r = make().plan(HOME, fields(), 'marina')
    expect(r).toMatchObject({ ok: false, code: 'needs_leader', detail: { why: 'no_spawn_template' } })
  })

  it('refuses a template pushed for another Walnut, or one without the sid, mode or persona slot', () => {
    const hs = make()
    expect(() => hs.setTemplate(HOME, { ...template(), home: '/Users/other' })).toThrow(/home/)
    const noSid = { ...template(), argv: template().argv.filter((a) => typeof a === 'string' || a.slot !== 'sid') }
    expect(() => hs.setTemplate(HOME, noSid)).toThrow(/sid/)
    const twice = { ...template(), argv: [...template().argv, { slot: 'mode' }] }
    expect(() => hs.setTemplate(HOME, twice)).toThrow(/slot/)
    expect(hs.templateOf(HOME)).toBeNull()
  })

  it('a daemon restarted while the Mac sleeps reads the saved template back (0600)', () => {
    make().setTemplate(HOME, template())
    const file = path.join(dir, 'spawn-template-k1.json')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    const r = make().plan(HOME, fields(), 'marina')
    expect(r.ok).toBe(true)
  })
})

describe('the template filled from fields only', () => {
  it('puts each field in its slot, after its flag, and nothing else', () => {
    const hs = make()
    hs.setTemplate(HOME, template())
    const r = hs.plan(HOME, fields({ model: 'opus', effort: 'low', mode: 'plan' }), 'marina')
    if (!r.ok) throw new Error(r.message)
    const a = r.plan.args
    expect(a[0]).toBe('claude')
    expect(a.slice(a.indexOf('--session-id'), a.indexOf('--session-id') + 2)).toEqual(['--session-id', SID])
    expect(a.slice(a.indexOf('--permission-mode'), a.indexOf('--permission-mode') + 2)).toEqual(['--permission-mode', 'plan'])
    expect(a.slice(a.indexOf('--model'), a.indexOf('--model') + 2)).toEqual(['--model', 'opus'])
    expect(a.slice(a.indexOf('--effort'), a.indexOf('--effort') + 2)).toEqual(['--effort', 'low'])
    // The first message rides stdin, never argv.
    expect(a.join('\n')).not.toContain('what is open today?')
    expect(r.plan.message).toBe('what is open today?')
    expect(r.plan.cwd).toBe(dir)
    expect(r.plan.record).toMatchObject({ kind: 'session', sid: SID, taskId: 'task-ask-1', host: 'marina', agentId: 'general', mode: 'plan', model: 'opus', effort: 'low' })
  })

  it('no model is Auto (no --model); effort follows the model capability', () => {
    const hs = make()
    hs.setTemplate(HOME, template())
    const auto = hs.plan(HOME, fields({ effort: 'medium' }), 'marina')
    if (!auto.ok) throw new Error(auto.message)
    expect(auto.plan.args).not.toContain('--model')
    expect(auto.plan.args).toContain('--effort')
    // A model the Mac says takes no effort (an older one) gets no --effort flag.
    hs.setTemplate(HOME, { ...template(), models: { ...template().models, haiku: { cli: 'haiku', effort: false } } })
    const haiku = hs.plan(HOME, fields({ sid: 'bbbbbbbb-1111-4111-8111-111111111111', model: 'haiku', effort: 'medium' }), 'marina')
    if (!haiku.ok) throw new Error(haiku.message)
    expect(haiku.plan.args).not.toContain('--effort')
    expect(haiku.plan.args).toContain('--model')
  })

  it('a field outside its allowlist refuses the whole start', () => {
    const hs = make()
    hs.setTemplate(HOME, template())
    // A model value that is not one CLI value (a flag, a shell word, two words).
    for (const model of ['-p', '--dangerously-skip-permissions', 'opus sonnet', 'opus;id', '']) {
      if (model) expect(hs.plan(HOME, fields({ model }), 'marina'), model).toMatchObject({ ok: false, code: 'bad_request' })
    }
    expect(hs.plan(HOME, fields({ effort: 'ultra' }), 'marina')).toMatchObject({ ok: false, code: 'bad_request' })
    expect(hs.plan(HOME, fields({ sid: 'not-a-uuid' }), 'marina')).toMatchObject({ ok: false, code: 'bad_request' })
    expect(hs.plan(HOME, fields({ cwd: '/etc' }), 'marina')).toMatchObject({ ok: false, code: 'bad_request' })
    expect(hs.plan(HOME, fields({ persona: { text: '--dangerously-skip-permissions' } }), 'marina')).toMatchObject({ ok: false, code: 'bad_request' })
    expect(hs.plan(HOME, fields({ persona: { text: 'x', allowedTools: ['Bash,Write'] } }), 'marina')).toMatchObject({ ok: false, code: 'bad_request' })
    // A key every object has is no mode of the template.
    for (const mode of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
      expect(hs.plan(HOME, fields({ mode }), 'marina'), mode).toMatchObject({ ok: false, code: 'bad_request' })
    }
  })
})

describe('mode allowlist', () => {
  it('the host default and plan; bypass refused unless the Mac allowed it for this Walnut', () => {
    const hs = make()
    hs.setTemplate(HOME, template())
    const def = hs.plan(HOME, fields(), 'marina')
    if (!def.ok) throw new Error(def.message)
    expect(def.plan.mode).toBe('default')
    expect(def.plan.args).toContain('default')
    expect(hs.plan(HOME, fields({ mode: 'bypass' }), 'marina')).toMatchObject({ ok: false, code: 'bad_request' })
    expect(hs.plan(HOME, fields({ mode: 'dontAsk' }), 'marina')).toMatchObject({ ok: false, code: 'bad_request' })
    hs.setTemplate(HOME, template({ bypassAllowed: true }))
    const by = hs.plan(HOME, fields({ mode: 'bypass' }), 'marina')
    if (!by.ok) throw new Error(by.message)
    expect(by.plan.args.slice(by.plan.args.indexOf('--permission-mode'))[1]).toBe('bypassPermissions')
    // The bare flag that SELECTS bypass is never in the template (only the capability).
    expect(by.plan.args).not.toContain('--dangerously-skip-permissions')
  })
})

describe('persona', () => {
  it('is written to a 0600 file in a 0700 dir, and passed as the string after the persona flag', () => {
    const hs = make()
    hs.setTemplate(HOME, template())
    const r = hs.plan(HOME, fields(), 'marina')
    if (!r.ok) throw new Error(r.message)
    expect(fs.statSync(r.plan.personaFile).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(r.plan.personaFile)).mode & 0o777).toBe(0o700)
    const i = r.plan.args.indexOf('--append-system-prompt')
    expect(r.plan.args[i + 1]).toBe('## Persona override\nYou are Walnut.\n\nYou are working on the task "What is open today".')
    expect(fs.readFileSync(r.plan.personaFile, 'utf8')).toBe(r.plan.args[i + 1])
  })

  it('over 120 KB on the argv path is refused (one argv string on Linux is 128 KB)', () => {
    const hs = make()
    hs.setTemplate(HOME, template())
    const r = hs.plan(HOME, fields({ persona: { text: 'x'.repeat(121 * 1024) } }), 'marina')
    expect(r).toMatchObject({ ok: false, code: 'bad_request', detail: { why: 'persona_too_large' } })
    // The file path has no such cap: the template passes it by path.
    hs.setTemplate(HOME, { ...template(), persona: 'file' })
    const f = hs.plan(HOME, fields({ persona: { text: 'x'.repeat(121 * 1024) } }), 'marina')
    if (!f.ok) throw new Error(f.message)
    expect(f.plan.args[f.plan.args.indexOf('--append-system-prompt-file') + 1]).toBe(f.plan.personaFile)
  })

  it('a start with no persona copy needs the Mac', () => {
    const hs = make()
    hs.setTemplate(HOME, template())
    expect(hs.plan(HOME, fields({ persona: undefined }), 'marina')).toMatchObject({ ok: false, code: 'needs_leader', detail: { why: 'persona_not_copied' } })
  })
})

describe('a model value outside the picker (the host catalog, a persona\'s launch model)', () => {
  it('rides as itself, as send() passes it, with --effort by the Mac\'s effort rules', () => {
    const hs = make()
    hs.setTemplate(HOME, template())
    const fable = hs.plan(HOME, fields({ model: 'global.anthropic.claude-fable-5[1m]', effort: 'high' }), 'marina')
    if (!fable.ok) throw new Error(fable.message)
    const a = fable.plan.args
    expect(a.slice(a.indexOf('--model'), a.indexOf('--model') + 2)).toEqual(['--model', 'global.anthropic.claude-fable-5[1m]'])
    expect(a.slice(a.indexOf('--effort'), a.indexOf('--effort') + 2)).toEqual(['--effort', 'high'])
    expect(fable.plan.record.model).toBe('global.anthropic.claude-fable-5[1m]')
    // Haiku 4.5 predates effort (core/types.ts MODEL_EFFORT_OVERRIDES): no --effort.
    const old = hs.plan(HOME, fields({ sid: 'bbbbbbbb-1111-4111-8111-111111111112', model: 'us.anthropic.claude-haiku-4-5', effort: 'high' }), 'marina')
    if (!old.ok) throw new Error(old.message)
    expect(old.plan.args).toContain('us.anthropic.claude-haiku-4-5')
    expect(old.plan.args).not.toContain('--effort')
  })

  it('a template\'s effort rule that is not one is refused', () => {
    const hs = make()
    expect(() => hs.setTemplate(HOME, { ...template(), effortRules: { overrides: [{ match: 'Opus 4; id', effort: false }], families: [] } })).toThrow(/effort rule/)
  })
})

describe('the walnut tools of a host ask', () => {
  it('no walnut MCP mount: the walnut CLI reaches the gateway, as every session the Mac runs on a remote host', () => {
    const hs = make()
    hs.setTemplate(HOME, template())
    const r = hs.plan(HOME, fields(), 'marina')
    if (!r.ok) throw new Error(r.message)
    expect(r.plan.args).not.toContain('--mcp-config')
    expect(r.plan.args.join('\n')).not.toMatch(/mcpServers|dist\/cli\.js|OPEN_WALNUT_API_URL|127\.0\.0\.1/)
    // A template that still names an MCP slot is not one this daemon fills.
    expect(() => hs.setTemplate(HOME, { ...template(), argv: [...template().argv, { slot: 'mcp' }] })).toThrow(/slot/)
  })
})

describe('tool lists', () => {
  it('come from the Mac\'s template for that agent, never from the start', () => {
    const hs = make()
    hs.setTemplate(HOME, template({ agents: { mentor: { allowedTools: ['Bash(walnut:*)', 'Read'], tools: ['Bash', 'Read'] } } }))
    const m = hs.plan(HOME, fields({ agentId: 'mentor' }), 'marina')
    if (!m.ok) throw new Error(m.message)
    const a = m.plan.args
    expect(a.slice(a.indexOf('--allowedTools'), a.indexOf('--allowedTools') + 2)).toEqual(['--allowedTools', 'Bash(walnut:*),Read'])
    expect(a.slice(a.indexOf('--tools'), a.indexOf('--tools') + 2)).toEqual(['--tools', 'Bash,Read'])
    // An agent the template names no lists for: none (the lanes' own default).
    const g = hs.plan(HOME, fields({ sid: 'bbbbbbbb-1111-4111-8111-111111111113' }), 'marina')
    if (!g.ok) throw new Error(g.message)
    expect(g.plan.args).not.toContain('--allowedTools')
    expect(g.plan.args).not.toContain('--tools')
    // A start naming its own lists is refused, even harmless ones.
    expect(hs.plan(HOME, fields({ persona: { text: 'x', allowedTools: ['Read'] } }), 'marina')).toMatchObject({ ok: false, code: 'bad_request' })
    expect(hs.plan(HOME, fields({ persona: { text: 'x', tools: ['Read'] } }), 'marina')).toMatchObject({ ok: false, code: 'bad_request' })
  })

  it('a template tool rule that starts with a dash, or holds two rules, is refused', () => {
    const hs = make()
    for (const rule of ['-p', '--dangerously-skip-permissions', ' Read', 'Read,Write']) {
      expect(() => hs.setTemplate(HOME, template({ agents: { general: { allowedTools: [rule] } } })), rule).toThrow(/tool list/)
    }
    expect(hs.templateOf(HOME)).toBeNull()
  })
})

describe('precheck', () => {
  it('runs every check of a start with no task yet, writes nothing and starts nothing', () => {
    const hs = make()
    expect(hs.precheck(HOME, fields({ taskId: undefined }))).toMatchObject({ ok: false, code: 'needs_leader', detail: { why: 'no_spawn_template' } })
    hs.setTemplate(HOME, template())
    expect(hs.precheck(HOME, fields({ taskId: undefined }))).toBeNull()
    expect(fs.existsSync(path.join(dir, 'personas'))).toBe(false)
    // The same refusals as the start itself.
    expect(hs.precheck(HOME, fields({ taskId: undefined, mode: 'bypass' }))).toMatchObject({ ok: false, code: 'bad_request' })
    expect(hs.precheck(HOME, fields({ taskId: INJECT }))).toMatchObject({ ok: false, code: 'bad_request' })
    expect(hs.precheck(HOME, fields({ taskId: undefined, persona: { text: 'x'.repeat(121 * 1024) } }))).toMatchObject({ ok: false, detail: { why: 'persona_too_large' } })
    expect(hs.precheck(HOME, fields({ taskId: undefined, persona: undefined }))).toMatchObject({ ok: false, code: 'needs_leader', detail: { why: 'persona_not_copied' } })
    hs.begin(HOME); hs.begin(HOME)
    expect(hs.precheck(HOME, fields({ taskId: undefined }))).toMatchObject({ ok: false, code: 'throttled' })
    // The start itself still needs its task.
    expect(hs.plan(HOME, fields({ taskId: undefined }), 'marina')).toMatchObject({ ok: false, code: 'bad_request' })
  })
})

describe('once: one start per session id', () => {
  it('a retry while the first still starts gets its answer, never a second run; another Walnut\'s id is taken', async () => {
    const hs = make()
    let runs = 0
    let finish: (a: { ok: true; reply: Record<string, unknown> }) => void = () => {}
    const run = () => { runs++; return new Promise<{ ok: true; reply: Record<string, unknown> }>((r) => { finish = r }) }
    const first = hs.once(HOME, SID, run)
    const retry = hs.once(HOME, SID, run)
    expect(hs.firstStart(HOME, SID)).toBe(first)
    expect(hs.once('/Users/other/.open-walnut', SID, run)).toBe('taken')
    expect(hs.firstStart('/Users/other/.open-walnut', SID)).toBe('taken')
    finish({ ok: true, reply: { sid: SID, cwd: dir } })
    expect(await first).toEqual({ ok: true, reply: { sid: SID, cwd: dir } })
    expect(await retry).toEqual(await first)
    expect(runs).toBe(1)
    // Answered: still the first answer for 10 minutes, then forgotten.
    expect(await hs.once(HOME, SID, run)).toEqual({ ok: true, reply: { sid: SID, cwd: dir } })
    expect(runs).toBe(1)
    now += 11 * 60 * 1000
    expect(hs.firstStart(HOME, SID)).toBeNull()
  })

  it('a failed start is forgotten (nothing runs), and a throw is an answer too', async () => {
    const hs = make()
    const failed = await hs.once(HOME, SID, async () => ({ ok: false, error: 'follower.start: no CLI', extra: { errorKind: 'internal' } }))
    expect(failed).toMatchObject({ ok: false })
    expect(hs.firstStart(HOME, SID)).toBeNull()
    expect(await hs.once(HOME, SID, () => { throw new Error('boom') })).toMatchObject({ ok: false, error: 'follower.start: boom', extra: { errorKind: 'internal' } })
    expect(hs.firstStart(HOME, SID)).toBeNull()
  })
})

describe('limits', () => {
  it('2 starting at once, none while 20 are mid-turn, 10 per hour per Walnut', () => {
    const hs = make()
    hs.setTemplate(HOME, template())
    const a = hs.begin(HOME)
    hs.begin(HOME)
    expect(hs.plan(HOME, fields(), 'marina')).toMatchObject({ ok: false, code: 'throttled' })
    a()
    a() // a release is once only: one start is still under way
    expect(hs.plan(HOME, fields(), 'marina').ok).toBe(true)
    hs.begin(HOME)
    expect(hs.plan(HOME, fields(), 'marina')).toMatchObject({ ok: false, code: 'throttled' })
    const hs2 = make()
    hs2.setTemplate(HOME, template())
    busy = 20
    expect(hs2.plan(HOME, fields(), 'marina')).toMatchObject({ ok: false, code: 'throttled', message: 'this host is busy' })
    busy = 0
    for (let i = 0; i < 10; i++) hs2.begin(HOME)()
    const r = hs2.plan(HOME, fields(), 'marina')
    expect(r).toMatchObject({ ok: false, code: 'throttled' })
    now += 61 * 60 * 1000
    expect(hs2.plan(HOME, fields(), 'marina').ok).toBe(true)
  })
})

describe('an injection string in every field', () => {
  it('never becomes its own argv element, a flag, or a shell word', () => {
    const hs = make()
    hs.setTemplate(HOME, template())
    const base = template().argv.filter((a): a is string => typeof a === 'string')
    for (const key of ['sid', 'taskId', 'agentId', 'title', 'cwd', 'model', 'effort', 'mode', 'firstMessage']) {
      const r = hs.plan(HOME, fields({ [key]: INJECT }), INJECT)
      if (key === 'title' || key === 'firstMessage') {
        // Free text: kept as data (the journal's title, the stdin message), never in argv.
        if (!r.ok) throw new Error(`${key}: ${r.message}`)
        expect(r.plan.args.some((x) => x.includes('pwned'))).toBe(false)
        expect(r.plan.record.host).toBe('')
        continue
      }
      expect(r, key).toMatchObject({ ok: false, code: 'bad_request' })
    }
    for (const sub of ['text', 'context']) {
      const persona = { text: 'You are Walnut.', [sub]: INJECT }
      const r = hs.plan(HOME, fields({ persona }), 'marina')
      if (!r.ok) throw new Error(`${sub}: ${r.message}`)
      // One argv element after its flag: the whole string, never split, never a flag of its own.
      const i = r.plan.args.indexOf('--append-system-prompt')
      expect(r.plan.args[i + 1]).toContain(INJECT)
      expect(r.plan.args.filter((x) => x.includes('pwned'))).toHaveLength(1)
      expect(r.plan.args).not.toContain('--dangerously-skip-permissions')
      expect(r.plan.args.filter((x) => !x.includes('pwned')).every((x) => base.includes(x) || /^--/.test(x) || !x.includes(' '))).toBe(true)
    }
    for (const sub of ['allowedTools', 'tools']) {
      expect(hs.plan(HOME, fields({ persona: { text: 'x', [sub]: [INJECT] } }), 'marina')).toMatchObject({ ok: false, code: 'bad_request' })
    }
    expect(hs.plan(HOME, fields({ persona: { text: 'x', mode: INJECT } }), 'marina')).toMatchObject({ ok: false, code: 'bad_request' })
  })
})

describe('a start kept on disk until its session record is (a daemon death in between)', () => {
  const SID = 'cccccccc-3333-4333-8333-000000000001'
  const record = { kind: 'session' as const, sid: SID, taskId: 'mtask-ask', host: 'marina', cwd: '/srv/asks', agentId: 'general', mode: 'default', title: 'Ask Walnut', startedAt: 1 }

  it('holds, lists (a new core reads it back), and releases a start', () => {
    const hs = make()
    hs.holdPending(HOME, { sid: SID, record, opId: 'op-1-session', actor: { kind: 'device', deviceId: 'd1' } })
    const file = path.join(dir, 'pending-starts', `k1-${SID}.json`)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(make().pendingStarts()).toEqual([{ home: HOME, sid: SID, record, opId: 'op-1-session', actor: { kind: 'device', deviceId: 'd1' }, at: now }])
    hs.releasePending(HOME, SID)
    expect(make().pendingStarts()).toEqual([])
    hs.releasePending(HOME, SID)
  })

  it('refuses a bad entry, and drops a file that does not read back as one start of its own name', () => {
    const hs = make()
    expect(() => hs.holdPending(HOME, { sid: 'not-a-uuid', record: { ...record, sid: 'not-a-uuid' } })).toThrow()
    expect(() => hs.holdPending(HOME, { sid: SID, record: { ...record, sid: 'cccccccc-3333-4333-8333-000000000002' } })).toThrow()
    const pd = path.join(dir, 'pending-starts')
    fs.mkdirSync(pd, { recursive: true })
    fs.writeFileSync(path.join(pd, 'k1-torn.json'), '{"v":1,')
    fs.writeFileSync(path.join(pd, `k9-${SID}.json`), JSON.stringify({ v: 1, home: HOME, sid: SID, record, at: 1 }))
    fs.writeFileSync(path.join(pd, `k1-${SID}.json`), JSON.stringify({ v: 1, home: HOME, sid: SID, record: { ...record, kind: 'note' }, at: 1 }))
    expect(hs.pendingStarts()).toEqual([])
    expect(fs.readdirSync(pd)).toEqual([])
  })
})

describe('a routine run (planRoutine, clock-host-start-v1)', () => {
  const RSID = 'dddddddd-4444-4444-8444-000000000001'
  function routineTemplate() {
    return buildRoutineSpawnTemplate({ home: HOME, hostKey: 'marina', env: {}, now })
  }
  function run(over: Record<string, unknown> = {}) {
    return {
      sid: RSID, taskId: 'mrun1-0a1b2c3d', title: 'Routine: nightly report', cwd: dir, mode: 'bypass',
      context: `You are working on the task "Routine: nightly report" (id ${START_TASK_TOKEN}, project "Routines").`, taskToken: START_TASK_TOKEN,
      firstMessage: 'write the nightly report', routine: { id: 'job-1', slotMs: 1_760_000_000_000 }, ...over,
    } as Parameters<HostStart['planRoutine']>[1]
  }

  it('needs the routine template: the ask template never serves a routine, and the routine one never an ask', () => {
    const hs = make()
    hs.setTemplate(HOME, template({ bypassAllowed: true }))
    expect(hs.planRoutine(HOME, run(), 'marina')).toMatchObject({ ok: false, code: 'needs_leader', detail: { why: 'no_spawn_template' } })
    const hs2 = make()
    fs.rmSync(path.join(dir, 'spawn-template-k1.json'))
    hs2.setTemplate(HOME, routineTemplate(), 'routine')
    expect(hs2.plan(HOME, fields(), 'marina')).toMatchObject({ ok: false, code: 'needs_leader', detail: { why: 'no_spawn_template' } })
    expect(fs.statSync(path.join(dir, 'spawn-template-routine-k1.json')).mode & 0o777).toBe(0o600)
    // A restarted daemon reads it back.
    expect(make().planRoutine(HOME, run(), 'marina').ok).toBe(true)
  })

  it('fills the Mac\'s argv: the run\'s sid, mode, model and effort, its context with the task id, no tool lists, in its folder', () => {
    const hs = make()
    hs.setTemplate(HOME, routineTemplate(), 'routine')
    const r = hs.planRoutine(HOME, run({ model: 'opus', effort: 'high' }), 'marina')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const a = r.plan.args
    expect(a[a.indexOf('--session-id') + 1]).toBe(RSID)
    expect(a[a.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
    expect(a).toContain('--model')
    expect(a[a.indexOf('--effort') + 1]).toBe('high')
    const ctx = a[a.indexOf('--append-system-prompt') + 1]
    expect(ctx).toContain('(id mrun1-0a1b2c3d, project "Routines")')
    expect(ctx).not.toContain(START_TASK_TOKEN)
    expect(a).not.toContain('--allowedTools')
    expect(a).not.toContain('--tools')
    expect(a).not.toContain('--system-prompt')
    expect(r.plan).toMatchObject({ sid: RSID, taskId: 'mrun1-0a1b2c3d', cwd: dir, mode: 'bypass', message: 'write the nightly report', personaFile: '' })
    expect(r.plan.record).toEqual({
      kind: 'session', sid: RSID, taskId: 'mrun1-0a1b2c3d', host: 'marina', cwd: dir, mode: 'bypass', title: 'Routine: nightly report',
      startedAt: now, firstMessage: 'write the nightly report', model: 'opus', effort: 'high', routine: { id: 'job-1', slotMs: 1_760_000_000_000 },
    })
    expect(r.plan.record.agentId).toBeUndefined()
  })

  it('refuses a folder that is missing here, a relative one, a mode the Mac did not allow, and a bad context', () => {
    const hs = make()
    hs.setTemplate(HOME, routineTemplate(), 'routine')
    expect(hs.planRoutine(HOME, run({ cwd: path.join(dir, 'gone') }), 'marina')).toMatchObject({ ok: false, code: 'cwd_missing' })
    expect(hs.planRoutine(HOME, run({ cwd: 'relative/dir' }), 'marina')).toMatchObject({ ok: false, code: 'bad_request' })
    expect(hs.planRoutine(HOME, run({ cwd: `${dir}/../x` }), 'marina')).toMatchObject({ ok: false, code: 'bad_request' })
    expect(Object.keys(hostRoutineModes().modes).sort()).toEqual(['bypass', 'default'])
    expect(hs.planRoutine(HOME, run({ mode: 'plan' }), 'marina')).toMatchObject({ ok: false, code: 'mode_not_allowed' })
    expect(hs.planRoutine(HOME, run({ mode: 'dontAsk' }), 'marina')).toMatchObject({ ok: false, code: 'mode_not_allowed' })
    expect(hs.planRoutine(HOME, run({ context: '--dangerously-skip-permissions' }), 'marina')).toMatchObject({ ok: false, code: 'bad_request' })
    expect(hs.planRoutine(HOME, run({ context: 'x'.repeat(121 * 1024) }), 'marina')).toMatchObject({ ok: false, detail: { why: 'persona_too_large' } })
    expect(hs.planRoutine(HOME, run({ sid: 'not-a-uuid' }), 'marina')).toMatchObject({ ok: false, code: 'bad_request' })
    expect(hs.planRoutine(HOME, run({ model: '--model=evil' }), 'marina')).toMatchObject({ ok: false, code: 'bad_request' })
    expect(hs.planRoutine(HOME, run({ firstMessage: '   ' }), 'marina')).toMatchObject({ ok: false, code: 'bad_request' })
  })

  it('an injection string in the message or title never reaches the argv as its own flag', () => {
    const hs = make()
    hs.setTemplate(HOME, routineTemplate(), 'routine')
    const r = hs.planRoutine(HOME, run({ firstMessage: INJECT, title: INJECT }), 'marina')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.args.join('\u0000')).not.toContain('pwned')
    expect(r.plan.args.filter((x) => x === '--dangerously-skip-permissions')).toEqual([])
    expect(r.plan.message).toBe(INJECT)
  })

  it('a routine template keeps no agents and needs no folder of its own', () => {
    const hs = make()
    const t = hs.setTemplate(HOME, { ...routineTemplate(), agents: { general: { allowedTools: ['Bash'] } }, cwd: 'not absolute' }, 'routine')
    expect(t.agents).toEqual({})
    expect(t.cwd).toBe('')
    expect(() => hs.setTemplate(HOME, routineTemplate(), 'other' as never)).toThrow(/use/)
  })

  it('shares the host limits with asks', () => {
    const hs = make()
    hs.setTemplate(HOME, routineTemplate(), 'routine')
    busy = 20
    expect(hs.planRoutine(HOME, run(), 'marina')).toMatchObject({ ok: false, code: 'throttled' })
  })

  it('keeps the run\'s task-create with its start on disk, and reads it back', () => {
    const hs = make()
    const r = (() => { hs.setTemplate(HOME, routineTemplate(), 'routine'); return hs.planRoutine(HOME, run(), 'marina') })()
    if (!r.ok) throw new Error('no plan')
    const task = { record: { kind: 'task-create' as const, taskId: 'mrun1-0a1b2c3d', fields: { title: 'Routine: nightly report', pinned: false }, placement: { project: 'Routines' } }, opId: 'routine-abc', jobId: 'job-1' }
    hs.holdPending(HOME, { sid: RSID, record: r.plan.record, opId: 'routine-abc-session', task })
    expect(make().pendingStarts()).toEqual([{ home: HOME, sid: RSID, record: r.plan.record, opId: 'routine-abc-session', task, at: now }])
    // A task-create for another task is not this start's: it is dropped, the start kept.
    hs.holdPending(HOME, { sid: RSID, record: r.plan.record, opId: 'routine-abc-session', task: { ...task, record: { ...task.record, taskId: 'other' } } })
    expect(make().pendingStarts()[0].task).toBeUndefined()
  })
})
