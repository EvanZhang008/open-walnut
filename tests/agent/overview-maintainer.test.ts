/**
 * Overview maintainer — the task-lifecycle learning hook.
 *
 * Project is the task model's only grouping layer, so the maintainer keys off
 * `task.project` and resolves it to a skill directory by NAME SEARCH across the
 * skill grouping dirs (`resolveProjectSkillDir`). NOTE: "category" below is only
 * ever the SKILL grouping directory (work/, projects/, …) — a separate concept
 * from the retired task category.
 */
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
import {
  skillHistoryDir,
  resolveProjectSkillDir,
  OVERVIEW_LOG_ROTATE_LIMIT,
  type ProjectSkillLocation,
} from '../../src/core/overview-log.js';
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

/** Skill grouping directory (NOT a task category) the fixtures live under. */
const SKILL_CAT = 'work';
const PROJECT = 'walnut';
const LOCATION: ProjectSkillLocation = { skillCategory: SKILL_CAT, name: PROJECT };
/** How skill_manage addresses a project skill: its DISCOVERY KEY = bare dir name. */
const SKILL_KEY = PROJECT;

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-1',
    title: 'Ship the history.db index',
    status: 'todo',
    priority: 'medium',
    project: PROJECT,
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

/** Seed a project skill at skills/<skillCategory>/<project>/SKILL.md. */
async function seedProjectSkill(name = PROJECT, skillCategory = SKILL_CAT): Promise<void> {
  const dir = path.join(GLOBAL_SKILLS_DIR, skillCategory, name);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: '${name} project skill'\ntype: knowledge\n---\n\n# ${name}\n\nCurrent direction: build the butler.\n`,
  );
}

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

describe('project → skill resolution', () => {
  it('finds the skill by name across grouping dirs, case-insensitively', async () => {
    await seedProjectSkill('Walnut', 'personal');
    expect(resolveProjectSkillDir('walnut')).toEqual({ skillCategory: 'personal', name: 'Walnut' });
  });

  it('prefers the alphabetically first grouping dir when two hold the same project', async () => {
    await seedProjectSkill(PROJECT, 'zzz-last');
    await seedProjectSkill(PROJECT, 'aaa-first');
    // Stable choice matters: the maintainer must write to the same skill on
    // every run, not alternate between two directories.
    expect(resolveProjectSkillDir(PROJECT)?.skillCategory).toBe('aaa-first');
  });

  it('returns null for Inbox and for path-bearing names', async () => {
    await seedProjectSkill();
    expect(resolveProjectSkillDir('')).toBeNull();
    expect(resolveProjectSkillDir('  ')).toBeNull();
    expect(resolveProjectSkillDir('../escape')).toBeNull();
    expect(resolveProjectSkillDir(`${SKILL_CAT}/${PROJECT}`)).toBeNull();
  });
});

describe('gating', () => {
  it('runs for a main task whose project owns a skill', async () => {
    await seedProjectSkill();
    const runner = vi.fn(async () => ({ response: 'ok' }));
    const ran = await maybeRunForTaskEvent(EventNames.TASK_CREATED, makeTask(), 'api', runner);
    expect(ran).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('skips subtasks silently', async () => {
    await seedProjectSkill();
    const runner = vi.fn(async () => ({ response: 'ok' }));
    const ran = await maybeRunForTaskEvent(
      EventNames.TASK_CREATED, makeTask({ parent_task_id: 'parent-1' }), 'api', runner,
    );
    expect(ran).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it('skips projects without a skill', async () => {
    const runner = vi.fn(async () => ({ response: 'ok' }));
    const ran = await maybeRunForTaskEvent(
      EventNames.TASK_CREATED, makeTask({ project: 'no-skill-project' }), 'api', runner,
    );
    expect(ran).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it('skips Inbox tasks (no project → no project skill)', async () => {
    await seedProjectSkill();
    const runner = vi.fn(async () => ({ response: 'ok' }));
    for (const project of ['', '   ']) {
      const ran = await maybeRunForTaskEvent(
        EventNames.TASK_CREATED, makeTask({ id: `inbox-${project.length}`, project }), 'api', runner,
      );
      expect(ran).toBe(false);
    }
    expect(runner).not.toHaveBeenCalled();
  });

  it('skips bulk sync/reconcile/migration sources', async () => {
    await seedProjectSkill();
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
    await seedProjectSkill();
    const runner = vi.fn(async () => ({ response: 'ok' }));
    expect(await maybeRunForTaskEvent(EventNames.TASK_CREATED, makeTask(), 'api', runner)).toBe(true);
    expect(await maybeRunForTaskEvent(EventNames.TASK_CREATED, makeTask(), 'api', runner)).toBe(false);
    expect(await maybeRunForTaskEvent(EventNames.TASK_COMPLETED, makeTask(), 'api', runner)).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('resolves a lowercase skill directory for a mixed-case project name', async () => {
    await seedProjectSkill('walnut');
    const runner = vi.fn(async () => ({ response: 'ok' }));
    const ran = await maybeRunForTaskEvent(
      EventNames.TASK_CREATED, makeTask({ project: 'Walnut' }), 'api', runner,
    );
    expect(ran).toBe(true);
  });

  it('serializes concurrent runs (one maintainer at a time)', async () => {
    await seedProjectSkill();
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
  it("log_append forces this project's skill and actually writes the log", async () => {
    await seedProjectSkill();
    const [skillManage] = buildMaintainerTools(LOCATION);
    const result = await skillManage.execute({
      action: 'log_append',
      category: 'somewhere-else', // ignored — the target is forced
      name: 'some-other-skill',   // ignored too
      content: 'Task "Ship the history.db index" created.',
    });
    expect(String(result)).toContain(`appended to ${PROJECT}'s history log`);
    const raw = fs.readFileSync(path.join(skillHistoryDir(SKILL_CAT, PROJECT), 'log.md'), 'utf-8');
    expect(raw).toContain('Task "Ship the history.db index" created.');
    expect(raw).toContain('task-hook');
  });

  it('log_append rotates at the size boundary (rotation stays in code)', async () => {
    await seedProjectSkill();
    const historyDir = skillHistoryDir(SKILL_CAT, PROJECT);
    await fsp.mkdir(historyDir, { recursive: true });
    await fsp.writeFile(path.join(historyDir, 'log.md'), 'x'.repeat(OVERVIEW_LOG_ROTATE_LIMIT));
    const [skillManage] = buildMaintainerTools(LOCATION);
    const result = await skillManage.execute({ action: 'log_append', content: 'rotation entry' });
    expect(String(result)).toContain('volume rotated');
    const files = fs.readdirSync(historyDir);
    expect(files.some((f) => /^log\.\d{8}-1\.md$/.test(f))).toBe(true);
  });

  it("patch is allowed ONLY on this project's skill", async () => {
    await seedProjectSkill();
    const [skillManage] = buildMaintainerTools(LOCATION);

    const denied = await skillManage.execute({
      action: 'patch', name: 'some-other-skill', old_string: 'a', new_string: 'b',
    });
    expect(String(denied)).toContain(`may only patch the '${SKILL_KEY}'`);

    const allowed = await skillManage.execute({
      action: 'patch',
      name: SKILL_KEY,
      old_string: 'Current direction: build the butler.',
      new_string: 'Current direction: butler + learning loops.',
    });
    expect(String(allowed)).toContain('patched');
    const raw = fs.readFileSync(path.join(GLOBAL_SKILLS_DIR, SKILL_CAT, PROJECT, 'SKILL.md'), 'utf-8');
    expect(raw).toContain('butler + learning loops');
  });

  it('delete and memory actions are refused', async () => {
    await seedProjectSkill();
    const [skillManage] = buildMaintainerTools(LOCATION);
    for (const action of ['delete', 'memory_add', 'memory_batch']) {
      const result = await skillManage.execute({ action, name: 'x', content: 'y' });
      expect(String(result)).toContain('not available to the overview maintainer');
    }
  });

  it('create passes through and emits a UI notification', async () => {
    await seedProjectSkill();
    const events: Array<{ name: string; data: unknown }> = [];
    bus.subscribe('test-skill-notify', (e) => { events.push({ name: e.name, data: e.data }); }, {
      global: true, interest: ['skill:notification'],
    });
    try {
      const [skillManage] = buildMaintainerTools(LOCATION);
      const result = await skillManage.execute({
        action: 'create',
        name: 'release-checklist',
        category: SKILL_CAT,
        type: 'action',
        description: 'Steps to cut a release safely',
        content: '# Release checklist\n\n1. Build. 2. Test. 3. Tag.',
      });
      expect(String(result)).toContain("Skill 'release-checklist' created");
      await vi.waitFor(() => expect(events).toHaveLength(1));
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
  it('includes task payload, skill content, and log tail', async () => {
    await seedProjectSkill();
    const [skillManage] = buildMaintainerTools(LOCATION);
    await skillManage.execute({ action: 'log_append', content: 'Earlier progress entry.' });

    const prompt = buildMaintainerPrompt(makeTask(), EventNames.TASK_COMPLETED, LOCATION);
    expect(prompt).toContain('[Task completed]');
    expect(prompt).toContain('Ship the history.db index');
    expect(prompt).toContain(`- Project: ${PROJECT}`);
    expect(prompt).toContain('Current direction: build the butler.');
    expect(prompt).toContain('Earlier progress entry.');
    expect(prompt).toContain(`action=log_append, category="${SKILL_CAT}"`);
    expect(prompt).toContain(`name="${SKILL_KEY}"`);
    // The on-disk path is two segments; the tool-addressable name is one.
    expect(prompt).toContain(`skills/${SKILL_CAT}/${PROJECT}/SKILL.md`);
  });
});

describe('bus wiring', () => {
  it('startOverviewMaintainer reacts to task:created bus events', async () => {
    await seedProjectSkill();
    // Verify the handler reached gating via the dedup set (the real runner would
    // hit the network). Emit for a project WITHOUT a skill so the handler runs
    // the cheap skip path — then a manual replay proves the event was consumed.
    startOverviewMaintainer();
    const task = makeTask({ id: 'bus-task', project: 'no-skill-project' });
    bus.emit(EventNames.TASK_CREATED, { task }, ['web-ui'], { source: 'api' });
    await new Promise((r) => setTimeout(r, 50));
    // Handler ran and recorded the dedup key → a replay with a runner is deduped.
    const runner = vi.fn(async () => ({ response: 'ok' }));
    const ran = await maybeRunForTaskEvent(EventNames.TASK_CREATED, task, 'api', runner);
    expect(ran).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });
});
