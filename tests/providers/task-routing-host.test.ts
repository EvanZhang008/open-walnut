import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createOfflineHost, type HostSlice } from '../../src/providers/offline-host-core.js';
import { createEnvelopeKit } from '../../src/core/peers/envelope-kit.js';
import { createOpenItemsText } from '../../src/core/sessions/open-items-text.js';
import { TASK_ROUTING_CONTRACT } from '../../src/core/task-routing-contract.js';

const home = '/fixture/routing';
const mainSid = 'aaaaaaaa-1111-4111-8111-111111111111';
const workerSid = 'bbbbbbbb-2222-4222-8222-222222222222';
const policy = createEnvelopeKit().buildWalnutMessage({ kind: 'notification', attrs: { from: 'Walnut', outcome: 'task-routing-policy' }, body: TASK_ROUTING_CONTRACT });
const dirs: string[] = [];
const local = (host: ReturnType<typeof createOfflineHost>, sid: string, args: Record<string, unknown>) =>
  host.handleLocal(home, sid, 'tools.call', { name: 'task_send', args });
function fixture(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-routing-host-'))) {
  dirs.push(dir);
  const writes: { sid: string; text: string; messageId: string; resumed?: boolean }[] = [];
  const live = new Set([mainSid, workerSid]);
  const state = { fail: false };
  const host = createOfflineHost({ fs, path, dir, now: () => Date.now(),
    randomHex: (n) => randomBytes(n).toString('hex'), keyOf: (value) => createHash('sha1').update(value).digest('hex'),
    kit: createEnvelopeKit(), openItems: createOpenItemsText(), log: () => {},
    isLive: (sid) => live.has(sid), turnActive: () => false, pendingPrompt: () => null, streamOffset: () => undefined,
    deliver: async (sid, text, messageId) => {
      if (state.fail) return { ok: false, reason: 'offline' };
      writes.push({ sid, text, messageId }); return { ok: true };
    },
    resume: async (_home, sid, text, messageId) => { writes.push({ sid, text, messageId, resumed: true }); return { ok: true }; },
  });
  const slice: HostSlice = { v: 1, home, hash: 'policy-one', asOf: Date.now(), host: 'fixture',
    sessions: [{ sid: mainSid, taskId: 'main-task', taskRoutingPolicy: policy }, { sid: workerSid, taskId: 'work-task' }],
    tasks: [{ id: 'main-task', title: 'Main', phase: 'IN_PROGRESS', project: 'Ask Walnut' },
      { id: 'work-task', title: 'Sorting', phase: 'IN_PROGRESS', project: 'Mobile' }], requests: [] };
  host.configure(slice);
  return { host, writes, live, state, dir, slice };
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('host-local routing policy from the receiving host slice', () => {
  it('local peers, replies and humans get the rule; normal workers do not', async () => {
    const f = fixture();
    const sent = await local(f.host, workerSid, { to: 'main-task', text: 'User asked for independent descriptions', expect_reply: false });
    expect(sent?.ok).toBe(true);
    expect(f.writes[0].text.startsWith(policy)).toBe(true);
    await f.host.deliverHuman(home, mainSid, 'A new user goal', 'qm-human-one');
    expect(f.writes[1].text.startsWith(policy)).toBe(true);
    await f.host.deliverHuman(home, workerSid, 'A sorting follow-up', 'qm-worker-one');
    expect(f.writes[2].text).toBe('A sorting follow-up');
    const ask = await local(f.host, mainSid, { to: 'work-task', text: 'Evidence only' });
    expect(ask?.ok).toBe(true);
    const id = ask!.ok ? ask!.result.requestId : '';
    await local(f.host, workerSid, { in_reply_to: id, text: 'Evidence reply' });
    expect(f.writes.at(-1)?.text.startsWith(policy)).toBe(true);
  });

  it('restart and an offline compact keep rules even after the server was told', async () => {
    const first = fixture();
    await first.host.deliverHuman(home, mainSid, 'first', 'qm-before');
    const restarted = fixture(first.dir);
    const compact = await restarted.host.handle(home, mainSid, 'tools.call', { name: 'open_items', args: { hook: 'compact' } });
    expect(compact.ok && (compact.result as any).hookSpecificOutput.additionalContext).toContain(TASK_ROUTING_CONTRACT);
    await restarted.host.deliverHuman(home, mainSid, 'after compact', 'qm-after');
    expect(restarted.writes[0].text.startsWith(policy)).toBe(true);
  });

  it('a slash command reaches the CLI as typed', async () => {
    const f = fixture();
    await f.host.deliverHuman(home, mainSid, '/compact', 'qm-slash');
    expect(f.writes[0].text).toBe('/compact');
  });

  it('recognizes a formal leading policy only, not a quote in human text', async () => {
    const f = fixture();
    await f.host.deliverHuman(home, mainSid, `${policy}\n\nUser goal`, 'qm-formal');
    expect(f.writes[0].text.split(policy)).toHaveLength(2);
    await f.host.deliverHuman(home, mainSid, `Here is a quote:\n${policy}\nNot configuration`, 'qm-quote');
    expect(f.writes[1].text.startsWith(policy)).toBe(true);
    expect(f.writes[1].text.split(policy)).toHaveLength(3);
  });

  it('failure retries once, duplicate ids do not send twice, cold resumes get the rule', async () => {
    const f = fixture();
    f.state.fail = true;
    expect((await f.host.deliverHuman(home, mainSid, 'goal', 'qm-retry')).ok).toBe(false);
    f.state.fail = false;
    await Promise.all([1, 2].map(() => f.host.deliverHuman(home, mainSid, 'goal', 'qm-retry')));
    expect(f.writes).toHaveLength(1);
    f.live.delete(mainSid);
    await f.host.deliverHuman(home, mainSid, 'resume goal', 'qm-resume');
    expect(f.writes[1]).toMatchObject({ resumed: true });
    expect(f.writes[1].text.startsWith(policy)).toBe(true);
  });

  it('updated slice removes rules only when the running prompt itself is current', async () => {
    const f = fixture();
    f.host.configure({ ...f.slice, hash: 'current-prompt', sessions: [{ sid: mainSid, taskId: 'main-task' }, { sid: workerSid, taskId: 'work-task' }] });
    await f.host.deliverHuman(home, mainSid, 'goal', 'qm-current');
    expect(f.writes[0].text).toBe('goal');
  });
});
