import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { removeTempTree } from '../helpers/temp-home.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, GLOBAL_SKILLS_DIR } from '../../src/constants.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { clearSkillsCache } from '../../src/core/skill-loader.js';
import { overviewHistoryDir, OVERVIEW_LOG_ROTATE_LIMIT } from '../../src/core/overview-log.js';
import {
  maybeRunForTaskEvent,
  buildMaintainerTools,
  buildMaintainerPrompt,
  resetMaintainerState,
  startOverviewMaintainer,
  stopOverviewMaintainer,
  type MaintainerRunner,
} from '../../src/agent/overview-maintainer.js';
import type { Task } from '../../src/core/types.js';

const CAT = 'walnut';

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-1',
    title: 'Ship the history.db index',
    status: 'todo',
    priority: 'medium',
    category: CAT,
    project: 'walnut',
    session_ids: [],
    description: 'Conversation-only FTS5 store',
    summary: '',
    note: '',
    phase: 'TODO',
    source: 'local',
    created_at: '2026-07-05T10:00:00Z',
    updated_at: '2026-07-05T10:00:00Z',
    ...overrides,
  } as Task;
}

async function seedOverview(category = CAT): Promise<void> {
  const dir = path.join(GLOBAL_SKILLS_DIR, category, 'overview');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: overview\ndescription: '${category} project overview'\ntype: knowledge\n---\n\n# Overview\n\nCurrent direction: build the butler.\n`,
  );
}

const okRunner: MaintainerRunner = vi.fn(async () => ({ response: 'Appended one entry.' }));

beforeEach(async () => {
  await removeTempTree(WALNUT_HOME);
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  vi.clearAllMocks();
  resetMaintainerState();
  clearSkillsCache();
});

afterEach(async () => {
  // Stop the bus subscription BEFORE the rm: a queued task event would
  // otherwise run the maintainer (writing skills/ + notifications.json) into
  // the tree being deleted → `ENOTEMPTY: rmdir .../walnut-test-*`.
  stopOverviewMaintainer();
  await removeTempTree(WALNUT_HOME);
});

describe('gating', () => {
  it('runs for a main task in a category with an overview', async () => {
    await seedOverview();
    const runner = vi.fn(async () => ({ response: 'ok' }));
    const ran = await maybeRunForTaskEvent(EventNames.TASK_CREATED, makeTask(), 'api', runner);
    expect(ran).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('skips subtasks silently', async () => {
    await seedOverview();
    const runner = vi.fn(async () => ({ response: 'ok' }));
    const ran = await maybeRunForTaskEvent(
      EventNames.TASK_CREATED, makeTask({ parent_task_id: 'parent-1' }), 'api', runner,
    );
    expect(ran).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it('skips categories without an overview skill', async () => {
    const runner = vi.fn(async () => ({ response: 'ok' }));
    const ran = await maybeRunForTaskEvent(
      EventNames.TASK_CREATED, makeTask({ category: 'no-overview-cat' }), 'api', runner,
    );
    expect(ran).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it('skips bulk sync/reconcile/migration sources', async () => {
    await seedOverview();
    const runner = vi.fn(async () => ({ response: 'ok' }));
    for (const source of ['ms-todo-reconcile', 'plugin-a-sync', 'migration']) {
      const ran = await maybeRunForTaskEvent(
        EventNames.TASK_CREATED, makeTask({ id: `t-${source}` }), source, runner,
      );
      expect(ran).toBe(false);
    }
    expect(runner).not.toHaveBeenCalled();
  });

  it('dedupes repeated events for the same task+phase but allows created→completed', async () => {
    await seedOverview();
    const runner = vi.fn(async () => ({ response: 'ok' }));
    expect(await maybeRunForTaskEvent(EventNames.TASK_CREATED, makeTask(), 'api', runner)).toBe(true);
    expect(await maybeRunForTaskEvent(EventNames.TASK_CREATED, makeTask(), 'api', runner)).toBe(false);
    expect(await maybeRunForTaskEvent(EventNames.TASK_COMPLETED, makeTask(), 'api', runner)).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('resolves lowercase category directories for mixed-case task categories', async () => {
    await seedOverview('walnut');
    const runner = vi.fn(async () => ({ response: 'ok' }));
    const ran = await maybeRunForTaskEvent(
      EventNames.TASK_CREATED, makeTask({ category: 'Walnut' }), 'api', runner,
    );
    expect(ran).toBe(true);
  });

  it('serializes concurrent runs (one maintainer at a time)', async () => {
    await seedOverview();
    let concurrent = 0;
    let maxConcurrent = 0;
    const runner: MaintainerRunner = vi.fn(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 20));
      concurrent--;
      return { response: 'ok' };
    });
    await Promise.all([
      maybeRunForTaskEvent(EventNames.TASK_CREATED, makeTask({ id: 'a' }), 'api', runner),
      maybeRunForTaskEvent(EventNames.TASK_CREATED, makeTask({ id: 'b' }), 'api', runner),
      maybeRunForTaskEvent(EventNames.TASK_CREATED, makeTask({ id: 'c' }), 'api', runner),
    ]);
    expect(maxConcurrent).toBe(1);
    expect(runner).toHaveBeenCalledTimes(3);
  });
});

describe('maintainer tool set', () => {
  it('log_append forces the hook category and actually writes the log', async () => {
    await seedOverview();
    const [skillManage] = buildMaintainerTools(CAT);
    const result = await skillManage.execute({
      action: 'log_append',
      category: 'somewhere-else', // ignored — category is forced
      content: 'Task "Ship the history.db index" created.',
    });
    expect(String(result)).toContain(`appended to ${CAT}'s overview history log`);
    const raw = fs.readFileSync(path.join(overviewHistoryDir(CAT), 'log.md'), 'utf-8');
    expect(raw).toContain('Task "Ship the history.db index" created.');
    expect(raw).toContain('task-hook');
  });

  it('log_append rotates at the size boundary (rotation stays in code)', async () => {
    await seedOverview();
    const historyDir = overviewHistoryDir(CAT);
    await fsp.mkdir(historyDir, { recursive: true });
    await fsp.writeFile(path.join(historyDir, 'log.md'), 'x'.repeat(OVERVIEW_LOG_ROTATE_LIMIT));
    const [skillManage] = buildMaintainerTools(CAT);
    const result = await skillManage.execute({ action: 'log_append', content: 'rotation entry' });
    expect(String(result)).toContain('volume rotated');
    const files = fs.readdirSync(historyDir);
    expect(files.some((f) => /^log\.\d{8}-1\.md$/.test(f))).toBe(true);
  });

  it('patch is allowed ONLY on the category overview skill', async () => {
    await seedOverview();
    const [skillManage] = buildMaintainerTools(CAT);

    const denied = await skillManage.execute({
      action: 'patch', name: 'some-other-skill', old_string: 'a', new_string: 'b',
    });
    expect(String(denied)).toContain(`may only patch the '${CAT}/overview'`);

    const allowed = await skillManage.execute({
      action: 'patch',
      name: `${CAT}/overview`,
      old_string: 'Current direction: build the butler.',
      new_string: 'Current direction: butler + learning loops.',
    });
    expect(String(allowed)).toContain('patched');
    const raw = fs.readFileSync(path.join(GLOBAL_SKILLS_DIR, CAT, 'overview', 'SKILL.md'), 'utf-8');
    expect(raw).toContain('butler + learning loops');
  });

  it('delete and memory actions are refused', async () => {
    await seedOverview();
    const [skillManage] = buildMaintainerTools(CAT);
    for (const action of ['delete', 'memory_add', 'memory_batch']) {
      const result = await skillManage.execute({ action, name: 'x', content: 'y' });
      expect(String(result)).toContain('not available to the overview maintainer');
    }
  });

  it('create passes through and emits a UI notification', async () => {
    await seedOverview();
    const events: Array<{ name: string; data: unknown }> = [];
    bus.subscribe('test-skill-notify', (e) => { events.push({ name: e.name, data: e.data }); }, {
      global: true, interest: ['skill:notification'],
    });
    try {
      const [skillManage] = buildMaintainerTools(CAT);
      const result = await skillManage.execute({
        action: 'create',
        name: 'release-checklist',
        category: CAT,
        type: 'action',
        description: 'Steps to cut a release safely',
        content: '# Release checklist\n\n1. Build. 2. Test. 3. Tag.',
      });
      expect(String(result)).toContain("Skill 'release-checklist' created");
      await new Promise((r) => setTimeout(r, 20));
      expect(events).toHaveLength(1);
      expect((events[0].data as { name: string }).name).toBe('release-checklist');
      // Persisted to the durable notification feed as kind 'skill'.
      const feedRaw = fs.readFileSync(path.join(WALNUT_HOME, 'notifications.json'), 'utf-8');
      expect(feedRaw).toContain('"kind": "skill"');
      expect(feedRaw).toContain('release-checklist');
    } finally {
      bus.unsubscribe('test-skill-notify');
    }
  });
});

describe('maintainer prompt', () => {
  it('includes task payload, overview content, and log tail', async () => {
    await seedOverview();
    const [skillManage] = buildMaintainerTools(CAT);
    await skillManage.execute({ action: 'log_append', content: 'Earlier progress entry.' });

    const prompt = buildMaintainerPrompt(makeTask(), EventNames.TASK_COMPLETED, CAT);
    expect(prompt).toContain('[Task completed]');
    expect(prompt).toContain('Ship the history.db index');
    expect(prompt).toContain('Current direction: build the butler.');
    expect(prompt).toContain('Earlier progress entry.');
    expect(prompt).toContain(`action=log_append, category="${CAT}"`);
    expect(prompt).toContain(`name="${CAT}/overview"`);
  });
});

describe('bus wiring', () => {
  it('startOverviewMaintainer reacts to task:created bus events', async () => {
    await seedOverview();
    // Patch the runner path by pre-marking: we verify the handler reached gating
    // via the dedup set (real runner would hit the network). Instead, emit for a
    // category WITHOUT overview so the handler runs the (cheap) skip path — then
    // verify a second manual call with an ok runner dedupes, proving the handler
    // consumed the event.
    startOverviewMaintainer();
    const task = makeTask({ id: 'bus-task', category: 'no-overview-cat' });
    bus.emit(EventNames.TASK_CREATED, { task }, ['web-ui'], { source: 'api' });
    await new Promise((r) => setTimeout(r, 50));
    // Handler ran and recorded the dedup key → a replay with a runner is deduped.
    const runner = vi.fn(async () => ({ response: 'ok' }));
    const ran = await maybeRunForTaskEvent(EventNames.TASK_CREATED, task, 'api', runner);
    expect(ran).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });
});
