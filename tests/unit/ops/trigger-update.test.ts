/**
 * trigger_update (src/ops/triggers.ts): a trigger is changed in place, keeping its id
 * and what it has seen. 2026-11-04: a check whose slow pipeline API call ran past the
 * 30 s default limit was stopped after five failures, and the only way to give it more
 * time was trigger_delete and trigger_create again, under a new id.
 *
 * Two class guards: every field trigger_create sets is either changeable here or named
 * with the reason it is not, and no agent-facing trigger text (op descriptions, the
 * skill, the failure notices) tells a session to delete and arm again to change one.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { getOp, listOps } from '../../../src/ops/index.js'
import { TRIGGER_UPDATE_FIELDS, TRIGGER_UPDATE_NOT_EDITABLE } from '../../../src/ops/triggers.js'
import { buildCheckFailureNotice } from '../../../src/core/routines/trigger-health.js'
import type { TriggerCheckedEvent } from '../../../src/providers/trigger-check-core.js'
import type { TriggerCheckedApplied } from '../../../src/core/cron/trigger-apply.js'

type Call = { method: string; path: string; body?: unknown }

function server(job: Record<string, unknown> | null) {
  const calls: Call[] = []
  let current = job
  const call = async (method: string, p: string, body?: unknown) => {
    calls.push({ method, path: p, body })
    if (!current) throw new Error('Cron job not found: nope')
    if (method === 'PATCH') current = { ...current, ...(body as object) }
    return { job: current }
  }
  return { calls, call }
}

const trigger = (over: Record<string, unknown> = {}) => ({
  id: 't1', name: 'Pipeline watch', enabled: true, state: {},
  description: 'Checks the pipeline every 5 minutes.',
  schedule: { kind: 'every', everyMs: 300_000 },
  check: { run: 'bash ~/.open-walnut/triggers/pipe/check.sh', host: 'devbox', cwd: '/work', maxFiresPerDay: 288 },
  executor: { type: 'session', config: { target: 'task-1', prompt: 'Look at the pipeline.' } },
  ...over,
})

const update = (args: Record<string, unknown>, s: ReturnType<typeof server>) =>
  getOp('trigger_update')!.handler!(args, s.call) as Promise<Record<string, unknown>>

describe('trigger_update', () => {
  it('raises the time limit in place: one PATCH of the same id, the rest of the check carried over', async () => {
    const s = server(trigger())
    const out = await update({ id: 't1', timeoutSeconds: 120 }, s)
    expect(s.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /routines/t1', 'PATCH /routines/t1'])
    expect(s.calls[1].body).toEqual({
      check: { run: 'bash ~/.open-walnut/triggers/pipe/check.sh', host: 'devbox', cwd: '/work', maxFiresPerDay: 288, timeoutSeconds: 120 },
    })
    expect(out).toMatchObject({ id: 't1', state: 'armed', changed: ['timeoutSeconds'], timeLimit: 120 })
    expect(String(out.outcome)).toMatch(/in place \(time limit\)\. Same id; it keeps the items it has seen/)
    expect(String(out.next)).toContain('trigger_test')
    expect(String(out.next)).toContain('"timeoutSeconds":120')
    // Tried on its own host and in its own directory, not the caller's.
    expect(String(out.next)).toContain('"host":"devbox","cwd":"/work"')
  })

  it('changes interval, prompt, description and name without touching the check', async () => {
    const s = server(trigger())
    const out = await update({ id: 't1', every: '10m', prompt: 'Retry the failed stage.', description: '  Checks   it every 10 minutes. ', name: 'Pipe' }, s)
    expect(s.calls[1].body).toEqual({
      schedule: { kind: 'every', everyMs: 600_000 },
      description: 'Checks it every 10 minutes.',
      name: 'Pipe',
      executor: { type: 'session', config: { target: 'task-1', prompt: 'Retry the failed stage.' } },
    })
    expect(out).toMatchObject({ every: '10m', changed: ['every', 'prompt', 'description', 'name'] })
    expect(String(out.next)).not.toContain('trigger_test')
  })

  it('a new command keeps host and directory; cwd "" clears the directory', async () => {
    const s = server(trigger())
    await update({ id: 't1', run: ' bash new.sh ', cwd: '' }, s)
    expect(s.calls[1].body).toEqual({ check: { run: 'bash new.sh', host: 'devbox', maxFiresPerDay: 288 } })
  })

  it('a stopped trigger stays off and says how to start it', async () => {
    const s = server(trigger({ enabled: false, state: { consecutiveErrors: 5 } }))
    const out = await update({ id: 't1', timeoutSeconds: 90 }, s)
    expect(out.state).toBe('stopped')
    expect(String(out.outcome)).toContain('It is still stopped: trigger_resume \'{"id":"t1"}\' starts it again.')
  })

  it('changes the words of a scheduled routine that starts a session turn, never its schedule (a VP\'s nightly reflection)', async () => {
    const routine = () => server({
      id: 'r2', name: 'Marina VP daily reflection', enabled: true, state: {},
      schedule: { kind: 'cron', expr: '0 20 * * *', tz: 'America/Los_Angeles' },
      executor: { type: 'session', config: { target: 'vp-1', prompt: 'Reflect on the day.' } },
    })
    const s = routine()
    const out = await update({ id: 'r2', prompt: 'Reflect on the day; read today\'s reflection record first.' }, s)
    expect(s.calls[1]).toMatchObject({ method: 'PATCH', path: '/routines/r2', body: { executor: { type: 'session', config: { target: 'vp-1', prompt: 'Reflect on the day; read today\'s reflection record first.' } } } })
    expect(out).toMatchObject({ id: 'r2', changed: ['prompt'] })
    const t = routine()
    await expect(update({ id: 'r2', every: '5m' }, t)).rejects.toThrow(/only prompt, description, name change here, not every/)
    expect(t.calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('refuses nothing to change, a plain routine, an unknown id, a bad interval, a long description, a template command', async () => {
    await expect(update({ id: 't1' }, server(trigger()))).rejects.toThrow(/nothing to change/)
    const plain = server({ id: 'r1', name: 'Digest', enabled: true, state: {}, schedule: { kind: 'every', everyMs: 60_000 } })
    await expect(update({ id: 'r1', every: '5m' }, plain)).rejects.toThrow(/starts no session turn/)
    expect(plain.calls.map((c) => c.method)).toEqual(['GET'])
    await expect(update({ id: 'nope', every: '5m' }, server(null))).rejects.toThrow(/not found/)
    await expect(update({ id: 't1', every: 'often' }, server(trigger()))).rejects.toThrow(/every must be/)
    await expect(update({ id: 't1', description: 'x'.repeat(601) }, server(trigger()))).rejects.toThrow(/limit is 600/)
    for (const blank of ['name', 'description', 'prompt', 'run'] as const) {
      await expect(update({ id: 't1', [blank]: '   ' }, server(trigger()))).rejects.toThrow(/cannot be blank/)
    }
    const tpl = server(trigger({ check: { run: 'walnut template x', host: '__local__', template: { id: 'mail:new-mail' } } }))
    await expect(update({ id: 't1', run: 'bash mine.sh' }, tpl)).rejects.toThrow(/plugin template/)
    expect(tpl.calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('takes the time limit only up to the daemon\'s maximum', () => {
    const schema = z.object(getOp('trigger_update')!.input).strict()
    expect(schema.safeParse({ id: 't1', timeoutSeconds: 300 }).success).toBe(true)
    expect(schema.safeParse({ id: 't1', timeoutSeconds: 301 }).success).toBe(false)
  })
})

describe('trigger_update replayed by the Mac (a change a host made while it was away)', () => {
  it('changes only the fields the host changed: one the Mac changed meanwhile stays, and a second replay changes nothing', async () => {
    // The Mac renamed it and set a new prompt while the host was away; the host raised the time limit.
    const s = server(trigger({ name: 'Renamed on the Mac', executor: { type: 'session', config: { target: 'task-1', prompt: 'New words from the Mac.' } } }))
    await update({ id: 't1', timeoutSeconds: 120 }, s)
    const once = (await s.call('GET', '/routines/t1')).job
    expect(once).toMatchObject({ name: 'Renamed on the Mac', executor: { config: { prompt: 'New words from the Mac.' } }, check: { run: 'bash ~/.open-walnut/triggers/pipe/check.sh', host: 'devbox', timeoutSeconds: 120 } })
    await update({ id: 't1', timeoutSeconds: 120 }, s)
    expect((await s.call('GET', '/routines/t1')).job).toEqual(once)
  })
})

describe('class guard: what trigger_create sets, trigger_update can change', () => {
  it('every trigger_create field is changeable or named with why not', () => {
    const create = Object.keys(getOp('trigger_create')!.input)
    const unaccounted = create.filter((f) => !(TRIGGER_UPDATE_FIELDS as readonly string[]).includes(f) && !(f in TRIGGER_UPDATE_NOT_EDITABLE))
    expect(unaccounted, 'add the new field to TRIGGER_UPDATE_FIELDS (and the op) or to TRIGGER_UPDATE_NOT_EDITABLE with why').toEqual([])
    const updateInput = Object.keys(getOp('trigger_update')!.input)
    for (const f of TRIGGER_UPDATE_FIELDS) expect(updateInput).toContain(f)
  })
})

describe('class guard: no trigger text says delete and arm again to change one', () => {
  // "trigger_delete ... then trigger_create", "arm the fixed one", "recreate it": each sends
  // a session the way that loses the trigger's id and seen items.
  const DELETE_AND_REARM = /trigger_delete[^\n]{0,80}\b(then|and)\b[^\n]{0,20}\b(arm|re-?arm|trigger_create)\b|arm the fixed one|\bre-?create (it|the trigger)\b/i

  const event = (over: Partial<TriggerCheckedEvent> = {}) => ({
    id: 't1', atMs: Date.parse('2026-11-04T10:00:00Z'), outcome: 'error', error: 'timed out', durationMs: 30_000, ...over,
  }) as TriggerCheckedEvent
  const applied = (over: Partial<TriggerCheckedApplied> = {}) => ({
    found: true, disabled: true, jobName: 'Pipeline watch', host: 'devbox', consecutiveErrors: 5,
    checkRun: 'bash check.sh', ...over,
  }) as TriggerCheckedApplied & { found: true }

  it('holds for every trigger op\'s description and inputs, the walnut-trigger skill and every failure notice', () => {
    const texts: Array<[string, string]> = []
    for (const op of listOps().filter((o) => o.name.startsWith('trigger_'))) {
      texts.push([`${op.name} description`, op.description])
      for (const [k, v] of Object.entries(op.input)) texts.push([`${op.name}.${k}`, (v as { description?: string }).description ?? ''])
    }
    const skill = path.resolve(__dirname, '../../../src/data/skills/walnut-trigger/SKILL.md')
    texts.push(['walnut-trigger skill', fs.readFileSync(skill, 'utf8')])
    for (const stage of ['failed', 'failing', 'disabled'] as const) {
      for (const killed of [false, true]) {
        for (const audience of [{ kind: 'owner' }, { kind: 'lead', owner: { id: 'o1', title: 'Owner', phase: 'COMPLETE', status: 'done' } }] as const) {
          const a = applied({ killedAtLimit: killed, timeLimitSeconds: 30 })
          texts.push([`notice ${stage} killed=${killed} ${audience.kind}`, buildCheckFailureNotice(event(), a, stage, audience as never)])
        }
      }
    }
    const hits = texts.filter(([, t]) => DELETE_AND_REARM.test(t)).map(([where]) => where)
    expect(hits).toEqual([])
  })

  it('holds for every source file and shipped skill, with string concatenations joined', () => {
    // 2026-11-15: the wait-until wake (src/core/task-wait-wake.ts) still said "trigger_delete,
    // then trigger_create" after the ops, skill and notices were fixed: any text Walnut sends counts.
    const root = path.resolve(__dirname, '../../../src')
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.(ts|tsx|md|mjs)$/.test(e.name)) files.push(p)
      }
    }
    walk(root)
    // Narrower than DELETE_AND_REARM: source has other things that are re-created on purpose.
    const SOURCE_DELETE_AND_REARM = /trigger_delete[^\n]{0,40}\btrigger_create\b|arm the fixed one/
    const hits = files.filter((f) => {
      const joined = fs.readFileSync(f, 'utf8').replace(/['"`]\s*\n?\s*\+\s*['"`]/g, '')
      return SOURCE_DELETE_AND_REARM.test(joined)
    }).map((f) => path.relative(root, f))
    expect(hits).toEqual([])
  })

  it('a trigger stopped at its time limit is told the trigger_update call with a larger limit', () => {
    const owner = buildCheckFailureNotice(event(), applied({ killedAtLimit: true, timeLimitSeconds: 30 }), 'disabled')
    expect(owner).toContain('Walnut stopped your trigger "Pipeline watch" (t1)')
    expect(owner).toContain('walnut tools call trigger_update \'{"id":"t1","timeoutSeconds":60}\'')
    expect(owner).toContain('trigger_resume')
    const big = buildCheckFailureNotice(event(), applied({ killedAtLimit: true, timeLimitSeconds: 200 }), 'disabled')
    expect(big).toContain('"timeoutSeconds":300')
    // Already at the maximum: no call that changes nothing, the script must get faster.
    const max = buildCheckFailureNotice(event(), applied({ killedAtLimit: true, timeLimitSeconds: 300 }), 'disabled')
    expect(max).not.toContain('"timeoutSeconds":300')
    expect(max).toContain('already the most a check may have (300 s)')
    // Changed before it is started again: the update line comes before trigger_resume.
    expect(owner.indexOf('trigger_update')).toBeLessThan(owner.indexOf('trigger_resume'))
    // Any other stop names trigger_update too, for a command or interval that is wrong.
    expect(buildCheckFailureNotice(event(), applied(), 'disabled')).toContain('trigger_update')
    // A first failure that was not a kill at the limit keeps its short note.
    expect(buildCheckFailureNotice(event(), applied({ disabled: false, consecutiveErrors: 1 }), 'failed')).not.toContain('trigger_update')
  })
})
