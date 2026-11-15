/**
 * trigger_create warns when its check only reads a background job of the calling session
 * (src/core/routines/own-job-watch.ts). 2026-11-15, the org reflection: task 6829713b armed a
 * 20-minute "validation completion" trigger whose script read its own Claude Code background
 * output files; it fired at 04:24, 05:24, 05:44 and 06:44 UTC and each turn was only an ack,
 * although Claude Code wakes a session by itself when its own background job ends.
 * The first test replays that script, verbatim.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getOp } from '../../../src/ops/index.js'
import { ownJobWatchWarning } from '../../../src/core/routines/own-job-watch.js'

const SID = '6fe655c9-c650-444c-86c0-765eb0cbb822'
const OTHER = 'aaaaaaaa-1111-4111-8111-111111111111'
const TASKS = `/private/tmp/claude-501/-Users-sam-code-app/${SID}/tasks`

// The check 6829713b armed (check-validation.py), as it was on the Mac (its user and project renamed).
const REPLAYED = `import hashlib
import json
import pathlib
import sys

inp = json.load(sys.stdin)
base = pathlib.Path('${TASKS}')
status = {}
for job in ['btl7add83', 'bfcag1xex']:
    file = base / (job + '.output')
    text = file.read_text(errors='replace') if file.exists() else ''
    status[job] = text.rsplit('\\n', 12)[-12:] if '[exited with code' in text or '[killed]' in text else ['running']
prev = inp.get('state') or {}
changed = [job for job, result in status.items() if result != ['running'] and result != prev.get(job)]
print(json.dumps({'fire': bool(changed), 'items': [{'id': job, 'job': job} for job in changed], 'state': status}))
`

let dir = ''
let savedSid: string | undefined
const write = (name: string, text: string) => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, text)
  return p
}
const job = { id: 'rt_9', name: 'Validation completion', schedule: { kind: 'every', everyMs: 1_200_000 } }
const create = (args: Record<string, unknown>) =>
  getOp('trigger_create')!.mapResult!({ body: { job, host: '__local__', nextCheckAt: null, wait: { parked: false, task_id: 't1', reason: 'wait_false' } }, args }) as
    { outcome: string; next: string; ownJobWarning?: string }

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-job-watch-'))
  savedSid = process.env.WALNUT_SESSION_ID
  process.env.WALNUT_SESSION_ID = SID
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  if (savedSid === undefined) delete process.env.WALNUT_SESSION_ID
  else process.env.WALNUT_SESSION_ID = savedSid
})

describe('trigger_create: a check on this session\'s own background job', () => {
  it('warns on the replayed 6829713b check and says to delete it and end the turn', () => {
    const script = write('check-validation.py', REPLAYED)
    const out = create({ run: `python3 ${script}`, every: '20m' })
    expect(out.outcome).toContain('WARNING: This check reads a background job of this session')
    expect(out.ownJobWarning).toMatch(/Claude Code already wakes this session when that job finishes/)
    expect(out.next).toBe(`Unless it also watches something outside this session, delete it now: walnut tools call trigger_delete '{"id":"rt_9"}', and end your turn; this session's own background job wakes it when it finishes.`)
  })

  it('reads a script named relative to cwd, under ~ too, and a check whose run line names the file', () => {
    write('check.sh', `tail -n 3 ${TASKS}/b123abc9.output | grep -q 'exited with code'`)
    expect(ownJobWatchWarning({ run: 'bash ./check.sh', cwd: dir, sid: SID })).not.toBeNull()
    expect(ownJobWatchWarning({ run: `grep -q exited ${TASKS}/b123abc9.output && echo '{"fire":true}'`, sid: SID })).not.toBeNull()
    // A subagent's transcript is the same session's job.
    expect(ownJobWatchWarning({ run: `test -s ~/.claude/projects/x/${SID}/subagents/agent-1.jsonl`, sid: SID })).not.toBeNull()
  })

  it('stays quiet for another session\'s job, a check that looks outside, a template, and a script it may not read', () => {
    // Another session's background output: not this one's, so nothing wakes this session for it.
    write('other.py', REPLAYED.replace(SID, OTHER))
    expect(create({ run: `python3 ${path.join(dir, 'other.py')}` }).outcome).not.toContain('WARNING')
    // It also reads CI or the network: a watch on something outside.
    write('ci.sh', `tail ${TASKS}/b1.output; gh run view 123 --json status`)
    expect(ownJobWatchWarning({ run: `bash ${path.join(dir, 'ci.sh')}`, sid: SID })).toBeNull()
    expect(ownJobWatchWarning({ run: `tail ${TASKS}/b1.output; curl -s https://ci.example/run/7`, sid: SID })).toBeNull()
    // A watch on a pull request, nothing of this session in it.
    expect(create({ run: 'bash ~/.open-walnut/triggers/pr/check.sh', every: '5m' }).outcome).not.toContain('WARNING')
    expect(create({ template: 'mail:new-mail', params: { from: 'a@' } }).outcome).not.toContain('WARNING')
    // A missing script reads as nothing.
    expect(ownJobWatchWarning({ run: `python3 ${path.join(dir, 'gone.py')}`, sid: SID })).toBeNull()
  })

  it('a comment\'s words are no outside watch, and a parked task is told to come out of Waiting', () => {
    write('commented.py', `# Watch the build, then fetch the exit status (a Walnut trigger check)\n${REPLAYED}`)
    expect(ownJobWatchWarning({ run: `python3 ${path.join(dir, 'commented.py')}`, sid: SID })).not.toBeNull()
    const parked = getOp('trigger_create')!.mapResult!({
      body: { job, host: '__local__', nextCheckAt: null, wait: { parked: true, task_id: 't1', wait_until: '2026-11-15T06:00:00.000Z' } },
      args: { run: `python3 ${path.join(dir, 'commented.py')}`, wait: true },
    }) as { next: string }
    expect(parked.next).toContain('then take the task out of Waiting (task_update phase=IN_PROGRESS)')
  })

  it('never reads a script in a place macOS guards, whatever its case, nor through a link', () => {
    const { macPlace } = require('../../../src/core/hosts/mac-places.js') as typeof import('../../../src/core/hosts/mac-places.js')
    expect(macPlace('/Users/sam/desktop/check.sh', { home: '/Users/sam' }, { foldCase: true })).toBe('~/Desktop')
    expect(macPlace('/volumes/x/check.sh', { home: '/Users/sam' }, { foldCase: true })).toBe('/Volumes')
    expect(macPlace('/Users/sam/desktop/check.sh', { home: '/Users/sam' })).toBeNull()
    const real = write('real.py', REPLAYED)
    const link = path.join(dir, 'link.py')
    fs.symlinkSync(real, link)
    expect(ownJobWatchWarning({ run: `python3 ${link}`, sid: SID })).toBeNull()
  })

  it('with no caller session known (the server running the op for a remote host), Claude Code\'s layout alone counts', () => {
    // The server reads no script for it: its disk is not that host's.
    write('server.py', REPLAYED)
    expect(ownJobWatchWarning({ run: `python3 ${path.join(dir, 'server.py')}` })).toBeNull()
    expect(ownJobWatchWarning({ run: `grep -q exited ${TASKS}/b1.output` })).not.toBeNull()
    expect(ownJobWatchWarning({ run: 'cat /tmp/claude-1000/-proj/*/tasks/b1.output' })).not.toBeNull()
    expect(ownJobWatchWarning({ run: 'bash ~/.open-walnut/triggers/pr/check.sh' })).toBeNull()
  })
})

describe('every place that tells a session when to arm a trigger says its own background job needs none', () => {
  const ROOT = path.resolve(__dirname, '../../..')
  it('the trigger_create description and the walnut-trigger skill', () => {
    expect(getOp('trigger_create')!.description).toContain('Never for this session\'s own background command (run_in_background) or subagent')
    const skill = fs.readFileSync(path.join(ROOT, 'src/data/skills/walnut-trigger/SKILL.md'), 'utf8').replace(/\s+/g, ' ')
    expect(skill).toContain('never on this session\'s own background command or subagent, which wakes it when done')
    expect(skill).toContain('One that runs in this session (a `run_in_background` command, a subagent) needs no trigger and no `wait_until`')
    // The old line that sent a session to arm a trigger on its own build is gone.
    expect(skill).not.toContain('Arm the trigger on it and park as usual')
  })

  it('no list of outside waits names a plain "a build" (a session\'s own build is not one)', () => {
    for (const rel of ['src/core/sessions/session-context.ts', 'src/ops/triggers.ts', 'src/data/skills/walnut-trigger/SKILL.md',
      'src/core/sessions/outside-wait.ts', 'src/core/status-consistency.ts']) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/'\s*\+\s*'/g, '').replace(/\s+/g, ' ')
      expect(text, rel).not.toMatch(/\ba build, a (?:deploy|review)|\ba deploy, a build\b/)
    }
  })
})
