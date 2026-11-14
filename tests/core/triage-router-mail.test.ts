import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/core/router/runtime.js', () => ({
  routerStore: () => { throw new Error('the triage mail filter must not read the ledger'); },
}));

import { routerAreasPath, type RouterAreasFile } from '../../src/core/router/areas.js';
import { keepTriageMailOutsideAreas } from '../../src/core/triage/router-mail.js';
import { mailArrival } from '../../src/core/triage/collect.js';
import { claimTriageBatch, loadTriageState, recordTriageArrivals, type TriagePendingMail } from '../../src/core/triage/state.js';
import { mailRouterKey } from '../../src/integrations/mail/router-source.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ACCOUNT = 'desk@example.invalid';
const OTHER = 'home@example.invalid';
const FRESH = 'fresh@example.invalid';
const RFC = '<moved-1@example.invalid>';

let home = '';

function registry(): RouterAreasFile {
  return {
    version: 1,
    areas: [{ id: 'alpha', name: 'Alpha', host: '__local__', taskIds: ['t-alpha'], sources: [{ kind: 'mail', account: ACCOUNT }] }],
    routers: [],
    items: [
      { source: { kind: 'mail', account: ACCOUNT, message: 'INBOX:1' }, areaId: 'alpha' },
      { source: { kind: 'mail', account: ACCOUNT, message: 'INBOX:2' }, areaId: 'alpha', canonicalKey: mailRouterKey(ACCOUNT, 'INBOX:2', RFC) },
    ],
  };
}

async function writeRegistry(value: unknown): Promise<void> {
  const file = routerAreasPath(home);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf-8');
}

const line = (subject: string, messageId?: string, canonicalKey?: string) => ({
  from: 'sender@example.invalid',
  subject,
  ...(messageId ? { messageId } : {}),
  ...(canonicalKey ? { canonicalKey } : {}),
});

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'triage-router-mail-'));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe('keepTriageMailOutsideAreas', () => {
  it('drops assigned mail, keeps unassigned and other-account mail, and keeps counts and times', async () => {
    await writeRegistry(registry());
    const rows: TriagePendingMail[] = [
      {
        accountId: ACCOUNT,
        count: 4,
        atMs: 11,
        headlines: [
          line('assigned', 'INBOX:1', mailRouterKey(ACCOUNT, 'INBOX:1')),
          line('unassigned', 'INBOX:9', mailRouterKey(ACCOUNT, 'INBOX:9')),
          line('moved copy', 'All:7', mailRouterKey(ACCOUNT, 'All:7', RFC)),
          line('legacy'),
        ],
      },
      { accountId: OTHER, count: 2, atMs: 12, headlines: [line('same id elsewhere', 'INBOX:1'), line('legacy elsewhere')] },
      { accountId: FRESH, count: 1, atMs: 13, headlines: [line('legacy fresh')] },
    ];
    const kept = await keepTriageMailOutsideAreas(rows, home);
    expect(kept.map((row) => [row.accountId, row.count, row.atMs, row.headlines.map((h) => h.subject)])).toEqual([
      [ACCOUNT, 4, 11, ['unassigned']],
      [OTHER, 2, 12, ['same id elsewhere', 'legacy elsewhere']],
      [FRESH, 1, 13, ['legacy fresh']],
    ]);
  });

  it('a key from the preview never widens a read: an exact assigned id stays hidden under any key', async () => {
    await writeRegistry(registry());
    const kept = await keepTriageMailOutsideAreas([
      { accountId: ACCOUNT, count: 1, atMs: 1, headlines: [line('forged key', 'INBOX:1', mailRouterKey(ACCOUNT, 'INBOX:404'))] },
    ], home);
    expect(kept).toEqual([{ accountId: ACCOUNT, count: 1, atMs: 1, headlines: [] }]);
  });

  it('keeps everything when no registry exists yet', async () => {
    const rows: TriagePendingMail[] = [{ accountId: ACCOUNT, count: 1, atMs: 1, headlines: [line('legacy'), line('new', 'INBOX:1')] }];
    expect(await keepTriageMailOutsideAreas(rows, home)).toEqual(rows);
  });

  it('fails closed on a damaged or invalid registry', async () => {
    const rows: TriagePendingMail[] = [{ accountId: ACCOUNT, count: 1, atMs: 1, headlines: [line('anything', 'INBOX:9')] }];
    await writeRegistry('{ not json');
    await expect(keepTriageMailOutsideAreas(rows, home)).rejects.toThrow();
    await writeRegistry({ ...registry(), items: [{ source: { kind: 'mail', account: ACCOUNT, message: 'INBOX:1' }, areaId: 'missing' }] });
    await expect(keepTriageMailOutsideAreas(rows, home)).rejects.toThrow();
  });

  it('fails closed when bindings exist and the inbound rules cannot be read; a stale binding reads no target', async () => {
    const bound = { ...registry(), ruleBindings: [{ ruleId: 'rr-1', revision: 'a'.repeat(64), areaId: 'alpha', confirmedAt: 1 }] };
    await writeRegistry(bound);
    const rows: TriagePendingMail[] = [{ accountId: FRESH, count: 1, atMs: 1, headlines: [line('anything', 'INBOX:9')] }];
    await fs.mkdir(path.join(home, 'triage'), { recursive: true });
    await fs.writeFile(path.join(home, 'triage', 'routing-rules.json'), '{ not json', 'utf-8');
    await expect(keepTriageMailOutsideAreas(rows, home)).rejects.toThrow();
    await fs.writeFile(path.join(home, 'triage', 'routing-rules.json'), JSON.stringify({ version: 1, rules: [] }), 'utf-8');
    expect(await keepTriageMailOutsideAreas(rows, home)).toEqual(rows);
  });

  it('mail queued before it was assigned is filtered when the batch is built, and the claim stays as it was', async () => {
    const arrival = mailArrival({
      accountId: ACCOUNT,
      count: 2,
      headlines: [line('later assigned', 'INBOX:1', mailRouterKey(ACCOUNT, 'INBOX:1')), line('still open', 'INBOX:9')],
    }, 5);
    expect(arrival?.headlines[0]).toEqual(line('later assigned', 'INBOX:1', mailRouterKey(ACCOUNT, 'INBOX:1')));
    await recordTriageArrivals({ mail: [arrival!] }, home);
    await writeRegistry(registry());
    const claimed = await claimTriageBatch(1_000, home);
    const kept = await keepTriageMailOutsideAreas(claimed.mail, home);
    expect(kept).toEqual([{ accountId: ACCOUNT, count: 2, atMs: 5, headlines: [line('still open', 'INBOX:9')] }]);
    const state = await loadTriageState(home);
    expect(state.claim?.mail).toBe(1);
    expect(state.pending.mail[0]?.headlines).toHaveLength(2);
  });
});

describe('source guards', () => {
  it('the filter reads only the area registry and the inbound rules: no mail cache, body, provider or ledger', async () => {
    const source = await fs.readFile(path.join(REPO, 'src/core/triage/router-mail.ts'), 'utf-8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual(['../router/areas.js', '../router/rules.js', '../router/source-reader.js', './state.js']);
    expect(source).toContain('readPendingRuleMatches(areas, home)');
    expect(source).toContain("sourceReaderFor({ kind: 'agent' }");
  });

  it('the batch action filters the claimed mail with the server home before it builds the batch', async () => {
    const source = await fs.readFile(path.join(REPO, 'src/actions/inbox-triage-batch.ts'), 'utf-8');
    const filter = source.indexOf('await keepTriageMailOutsideAreas(claimed.mail, home)');
    const claim = source.indexOf('await claimTriageBatch(nowMs, home)');
    const build = source.indexOf('buildTriageBatch({');
    expect(source).toContain('const home = ctx.WALNUT_HOME;');
    expect(claim).toBeGreaterThan(-1);
    expect(filter).toBeGreaterThan(claim);
    expect(build).toBeGreaterThan(filter);
    expect(source).not.toContain('mail: claimed.mail');
  });
});
