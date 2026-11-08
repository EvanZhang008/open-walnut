/**
 * A VP's task is titled "<project> VP" (2026-11-02, the user: "after we rename it from lead to vp,
 * why the task name still walnut lead, it should rename as Walnut VP"). Three parts: every place
 * that makes a VP's task names it through vpTaskTitle (a source scan that fails on a new one that
 * does not), the two makers do so for real, and the boot migration renames an open VP an older
 * build titled "<project> lead" while leaving a title the user wrote and a closed VP alone.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('walnut-vp-title'));
import { WALNUT_HOME } from '../../../src/constants.js';
import { addTask, getTask, updateTaskRaw } from '../../../src/core/task-manager.js';
import { createOrgNode } from '../../../src/core/org/org-node-edit.js';
import { ensureProjectLead } from '../../../src/core/org/org-store.js';
import { orgDisplayTitle, vpTaskTitle } from '../../../src/core/org/org-tree.js';
import { legacyVpTitleFix, renameLegacyVpTitles } from '../../../src/core/org/vp-title-migration.js';
import { resetCache } from '../../../src/core/session-message-queue.js';

const ROOT = path.resolve(__dirname, '../../..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') sourceFiles(p, out); }
    else if (/\.(ts|tsx|js|mjs|swift)$/.test(e.name)) out.push(p);
  }
  return out;
}

const SCANNED = ['src', 'web/src', 'ios-native/Walnut'].map((d) => path.join(ROOT, d)).filter((d) => fs.existsSync(d));
const files = SCANNED.flatMap((d) => sourceFiles(d)).map((f) => ({ rel: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }));

describe('every VP task Walnut makes is titled "<project> VP"', () => {
  it('each task create that sets org_role lead takes its title from vpTaskTitle', () => {
    const makers: string[] = [];
    const bad: string[] = [];
    for (const { rel, text } of files) {
      // A create's object: `{ ... org_role: 'lead' ... }` with a title in the same object.
      const re = /org_role:\s*['"]lead['"]/g;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const open = text.lastIndexOf('{', m.index);
        const close = text.indexOf('}', m.index);
        const obj = text.slice(open, close + 1);
        // Only an object handed to a task create; a display call (orgDisplayTitle) passes one too.
        if (!/\b(addTask|addTasks|addTasksBulk|createTask)\w*\(\s*$/.test(text.slice(Math.max(0, open - 80), open))) continue;
        if (!/\btitle\s*:/.test(obj)) continue;
        const line = text.slice(0, m.index).split('\n').length;
        makers.push(`${rel}:${line}`);
        if (!/\btitle\s*:\s*vpTaskTitle\(/.test(obj)) bad.push(`${rel}:${line}: ${obj.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
    expect(bad, 'a VP task made with a title of its own: use vpTaskTitle(project)').toEqual([]);
    // The two makers today (org-store ensureLeadNow, org-node-edit createOrgNode): a scan that finds none proves nothing.
    expect(makers.length).toBeGreaterThanOrEqual(2);
  });

  it('no source writes the old "<name> lead" title', () => {
    const hits: string[] = [];
    for (const { rel, text } of files) {
      if (rel.endsWith('vp-title-migration.ts')) continue;
      text.split('\n').forEach((l, i) => {
        // `${x} lead`, x + ' lead', "\(x) lead" (Swift): a title built with the old role word.
        if (/\}\s+lead`|\+\s*['"] lead['"]|\\\([^)]*\)\s+lead"/.test(l)) hits.push(`${rel}:${i + 1}: ${l.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('vpTaskTitle reads "<project> VP" and the display keeps it', () => {
    expect(vpTaskTitle(' Walnut ')).toBe('Walnut VP');
    expect(orgDisplayTitle({ title: 'Walnut VP', org_role: 'lead' })).toBe('Walnut VP');
    // An older build's title still shows as the VP.
    expect(orgDisplayTitle({ title: 'Walnut lead', org_role: 'lead' })).toBe('Walnut VP');
  });
});

describe('the makers and the migration, on a real task store', () => {
  beforeEach(async () => {
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
    await fsp.mkdir(WALNUT_HOME, { recursive: true });
    resetCache();
  });

  it('a first contact and the Org page both make "<project> VP"', async () => {
    await addTask({ title: 'Water the beds', project: 'Garden' });
    expect((await ensureProjectLead('Garden')).title).toBe('Garden VP');
    expect((await createOrgNode({ name: 'Orchard' }, false)).title).toBe('Orchard VP');
    expect((await createOrgNode({ name: 'Growth VP' }, true)).title).toBe('Growth VP');
  });

  it('renames an open VP titled the old way, and only that', async () => {
    const mk = async (title: string, project: string, phase?: 'COMPLETE' | 'IN_PROGRESS') => {
      const { task } = await addTask({ title, project, source: 'local', org_role: 'lead' } as never);
      if (phase) await updateTaskRaw(task.id, { phase });
      return task.id;
    };
    const old = await mk('Walnut lead', 'Walnut', 'IN_PROGRESS');
    const unicode = await mk('\u82b1\u56ed lead', '\u82b1\u56ed');
    const roleWordProject = await mk('Supply lead lead', 'Supply lead');
    const userNamed = await mk('Release captain lead', 'Ship');
    const userWords = await mk('Walnut lead notes', 'Notes');
    const closed = await mk('Docs lead', 'Docs', 'COMPLETE');
    const plain = (await addTask({ title: 'Team lead', project: 'Team' })).task.id;

    expect(await renameLegacyVpTitles()).toBe(3);
    expect((await getTask(old)).title).toBe('Walnut VP');
    expect((await getTask(unicode)).title).toBe('\u82b1\u56ed VP');
    expect((await getTask(roleWordProject)).title).toBe('Supply lead VP');
    expect((await getTask(userNamed)).title).toBe('Release captain lead');
    expect((await getTask(userWords)).title).toBe('Walnut lead notes');
    expect((await getTask(closed)).title).toBe('Docs lead');
    expect((await getTask(plain)).title).toBe('Team lead');
    // A second boot finds nothing to do.
    expect(await renameLegacyVpTitles()).toBe(0);
  });

  it('renames the old CEO default at boot and preserves a chosen title', async () => {
    const old = (await addTask({ title: 'Main', org_role: 'main', project: 'Ask Walnut' })).task;
    expect(await renameLegacyVpTitles()).toBe(1);
    expect((await getTask(old.id)).title).toBe('CEO');
    await updateTaskRaw(old.id, { title: 'My coordinator' });
    expect(await renameLegacyVpTitles()).toBe(0);
    expect((await getTask(old.id)).title).toBe('My coordinator');
  });

  it('a concurrent chosen title wins over the default title upgrade', async () => {
    const old = (await addTask({ title: 'Main', org_role: 'main', project: 'Ask Walnut', description: 'Keep this text' })).task;
    for (let n = 0; n < 4; n++) {
      await updateTaskRaw(old.id, { title: 'Main' });
      await Promise.all([
        renameLegacyVpTitles(),
        updateTaskRaw(old.id, { title: 'My coordinator' }),
      ]);
      expect(await getTask(old.id)).toMatchObject({
        id: old.id, title: 'My coordinator', project: 'Ask Walnut', description: 'Keep this text', org_role: 'main',
      });
      expect(await renameLegacyVpTitles()).toBe(0);
    }
  });

  it('legacyVpTitleFix ignores case changes the user made and an empty project', () => {
    expect(legacyVpTitleFix({ title: 'Walnut Lead', org_role: 'lead', phase: 'TODO', project: 'Walnut' })).toBeNull();
    expect(legacyVpTitleFix({ title: ' lead', org_role: 'lead', phase: 'TODO', project: '' })).toBeNull();
    expect(legacyVpTitleFix({ title: 'walnut lead', org_role: 'lead', phase: 'TODO', project: 'Walnut' })).toBe('walnut VP');
    expect(legacyVpTitleFix({ title: 'Main', org_role: 'main', phase: 'TODO', project: 'Ask Walnut' })).toBe('CEO');
    for (const title of ['MAIN', 'Main coordinator', 'My coordinator', 'CEO']) {
      expect(legacyVpTitleFix({ title, org_role: 'main', phase: 'TODO', project: 'Ask Walnut' })).toBeNull();
    }
    expect(legacyVpTitleFix({ title: 'Main', org_role: 'main', phase: 'COMPLETE', project: 'Ask Walnut' })).toBeNull();
    expect(legacyVpTitleFix({ title: 'Main', phase: 'TODO', project: 'Ask Walnut' })).toBeNull();
  });
});
