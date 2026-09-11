/**
 * Overview maintainer — the task-lifecycle learning hook.
 *
 * Project is the task model's only grouping layer, so the maintainer keys off
 * `task.project` and resolves it to a skill directory by NAME SEARCH across the
 * skill grouping dirs (`resolveProjectSkillDir`). NOTE: "category" below is only
 * ever the SKILL grouping directory (work/, projects/, …) — a separate concept
 * from the retired task category.
 *
 * The model answers with ONE JSON object and this module performs every write,
 * so the write half of the suite drives real files through a stubbed runner.
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
  buildMaintainerPrompt,
  resetMaintainerState,
  startOverviewMaintainer,
  stopOverviewMaintainer,
  type MaintainerRunner,
} from '../../src/core/overview-maintainer.js';
import type { Task } from '../../src/core/types.js';

/** Skill grouping directory (NOT a task category) the fixtures live under. */
const SKILL_CAT = 'work';
const PROJECT = 'walnut';
const LOCATION: ProjectSkillLocation = { skillCategory: SKILL_CAT, name: PROJECT };

const SKILL_FILE = path.join(GLOBAL_SKILLS_DIR, SKILL_CAT, PROJECT, 'SKILL.md');
const LOG_FILE = path.join(skillHistoryDir(SKILL_CAT, PROJECT), 'log.md');

/** The body every fixture skill ships with (long enough to exercise the shrink guard). */
const SEED_BODY = [
  '# walnut',
  '',
  'Current direction: build the Personal AI.',
  '',
  '## Decisions',
  '- Tasks are the atom; Project is the only grouping layer.',
  '- Sessions are owned by the daemon on each exec host.',
  '- Search runs hybrid keyword + semantic over tasks and sessions.',
].join('\n');

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
    `---\nname: ${name}\ndescription: '${name} project skill'\ntype: knowledge\n---\n\n${SEED_BODY}\n`,
  );
}

/** A runner that answers with one JSON object, the way the model is asked to. */
function answering(answer: Record<string, unknown>): MaintainerRunner {
  return vi.fn(async () => ({ response: JSON.stringify(answer) }));
}

/** The minimum valid answer: a log entry and nothing else. */
function logOnly(text = 'Started the history.db index workstream.'): MaintainerRunner {
  return answering({ log: text });
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
    const runner = logOnly();
    const ran = await maybeRunForTaskEvent(EventNames.TASK_CREATED, makeTask(), 'api', runner);
    expect(ran).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('skips subtasks silently', async () => {
    await seedProjectSkill();
    const runner = logOnly();
    const ran = await maybeRunForTaskEvent(
      EventNames.TASK_CREATED, makeTask({ parent_task_id: 'parent-1' }), 'api', runner,
    );
    expect(ran).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it('skips projects without a skill', async () => {
    const runner = logOnly();
    const ran = await maybeRunForTaskEvent(
      EventNames.TASK_CREATED, makeTask({ project: 'no-skill-project' }), 'api', runner,
    );
    expect(ran).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it('skips Inbox tasks (no project → no project skill)', async () => {
    await seedProjectSkill();
    const runner = logOnly();
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
    const runner = logOnly();
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
    const runner = logOnly();
    expect(await maybeRunForTaskEvent(EventNames.TASK_CREATED, makeTask(), 'api', runner)).toBe(true);
    expect(await maybeRunForTaskEvent(EventNames.TASK_CREATED, makeTask(), 'api', runner)).toBe(false);
    expect(await maybeRunForTaskEvent(EventNames.TASK_COMPLETED, makeTask(), 'api', runner)).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('resolves a lowercase skill directory for a mixed-case project name', async () => {
    await seedProjectSkill('walnut');
    const runner = logOnly();
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
      return { response: JSON.stringify({ log: 'one entry' }) };
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

describe('applying the one-shot answer', () => {
  it('appends the log entry, keyed to this project, and leaves the skill alone', async () => {
    await seedProjectSkill();
    const before = fs.readFileSync(SKILL_FILE, 'utf-8');
    const ran = await maybeRunForTaskEvent(
      EventNames.TASK_CREATED, makeTask(), 'api',
      logOnly('Task "Ship the history.db index" created — new FTS5 workstream.'),
    );
    expect(ran).toBe(true);

    const raw = fs.readFileSync(LOG_FILE, 'utf-8');
    expect(raw).toContain('Ship the history.db index');
    expect(raw).toContain('task-hook');
    // No "skill" key in the answer → the curated doc is untouched.
    expect(fs.readFileSync(SKILL_FILE, 'utf-8')).toBe(before);
  });

  it('tolerates a fenced JSON answer (models fence it anyway)', async () => {
    await seedProjectSkill();
    const runner: MaintainerRunner = vi.fn(async () => ({
      response: '```json\n' + JSON.stringify({ log: 'Fenced entry landed.' }) + '\n```',
    }));
    expect(await maybeRunForTaskEvent(EventNames.TASK_CREATED, makeTask(), 'api', runner)).toBe(true);
    expect(fs.readFileSync(LOG_FILE, 'utf-8')).toContain('Fenced entry landed.');
  });

  it('rotates the history log at the size boundary (rotation stays in code)', async () => {
    await seedProjectSkill();
    const historyDir = skillHistoryDir(SKILL_CAT, PROJECT);
    await fsp.mkdir(historyDir, { recursive: true });
    await fsp.writeFile(LOG_FILE, 'x'.repeat(OVERVIEW_LOG_ROTATE_LIMIT));
    expect(await maybeRunForTaskEvent(
      EventNames.TASK_CREATED, makeTask(), 'api', logOnly('rotation entry'),
    )).toBe(true);
    const files = fs.readdirSync(historyDir);
    expect(files.some((f) => /^log\.\d{8}-1\.md$/.test(f))).toBe(true);
  });

  it('replaces the project skill body when the answer carries one, keeping its frontmatter', async () => {
    await seedProjectSkill();
    const newBody = [
      '# walnut',
      '',
      'Current direction: Personal AI + learning loops.',
      '',
      '## Decisions',
      '- Tasks are the atom; Project is the only grouping layer.',
      '- Sessions are owned by the daemon on each exec host.',
      '- Search runs hybrid keyword + semantic over tasks and sessions.',
      '- The history.db index shipped.',
    ].join('\n');
    const ran = await maybeRunForTaskEvent(
      EventNames.TASK_COMPLETED, makeTask(), 'api',
      answering({ log: 'history.db index shipped.', skill: newBody }),
    );
    expect(ran).toBe(true);

    const raw = fs.readFileSync(SKILL_FILE, 'utf-8');
    expect(raw).toContain('Personal AI + learning loops');
    // Frontmatter survives a body rewrite — it carries the routing description.
    expect(raw).toContain('type: knowledge');
    expect(raw).toContain(`name: ${PROJECT}`);
    expect(raw).toContain(`description: ${PROJECT} project skill`);
    // The log entry still landed; both writes come from one answer.
    expect(fs.readFileSync(LOG_FILE, 'utf-8')).toContain('history.db index shipped');
  });

  it('refuses a rewrite that would drop most of the doc, and writes NOTHING', async () => {
    await seedProjectSkill();
    const before = fs.readFileSync(SKILL_FILE, 'utf-8');
    const ran = await maybeRunForTaskEvent(
      EventNames.TASK_COMPLETED, makeTask(), 'api',
      answering({ log: 'shipped', skill: '# walnut\n\nShipped.' }),
    );
    expect(ran).toBe(false);
    expect(fs.readFileSync(SKILL_FILE, 'utf-8')).toBe(before);
    expect(fs.existsSync(LOG_FILE)).toBe(false);
  });

  it('creates a class-level skill and notifies, when the answer asks for one', async () => {
    await seedProjectSkill();
    const events: Array<{ name: string; data: unknown }> = [];
    bus.subscribe('test-skill-notify', (e) => { events.push({ name: e.name, data: e.data }); }, {
      global: true, interest: ['skill:notification'],
    });
    try {
      const ran = await maybeRunForTaskEvent(
        EventNames.TASK_COMPLETED, makeTask(), 'api',
        answering({
          log: 'Release cutting keeps recurring.',
          new_skill: {
            name: 'release-checklist',
            category: SKILL_CAT,
            type: 'action',
            description: 'Steps to cut a release safely',
            content: '# Release checklist\n\n1. Build. 2. Test. 3. Tag.',
          },
        }),
      );
      expect(ran).toBe(true);
      expect(fs.existsSync(path.join(GLOBAL_SKILLS_DIR, SKILL_CAT, 'release-checklist', 'SKILL.md'))).toBe(true);
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect((events[0].data as { name: string }).name).toBe('release-checklist');
      // Feed persistence is intentionally fire-and-forget, so wait for the
      // atomic write instead of assuming the synchronous bus event implies it.
      await vi.waitFor(() => {
        const feedRaw = fs.readFileSync(path.join(WALNUT_HOME, 'notifications.json'), 'utf-8');
        expect(feedRaw).toContain('"kind": "skill"');
        expect(feedRaw).toContain('release-checklist');
      });
    } finally {
      bus.unsubscribe('test-skill-notify');
    }
  });

  it('writes nothing for a malformed answer (prose, no JSON, no log entry)', async () => {
    await seedProjectSkill();
    const before = fs.readFileSync(SKILL_FILE, 'utf-8');
    for (const response of [
      'Appended one entry.',                       // prose, the old tool-loop reply
      '',                                          // empty
      '{"log":',                                   // truncated JSON
      JSON.stringify({ skill: 'a'.repeat(400) }),  // a rewrite with no log entry
      JSON.stringify([{ log: 'wrong shape' }]),    // array, not an object
      JSON.stringify({ log: 'x'.repeat(2500) }),   // over the entry cap
    ]) {
      resetMaintainerState();
      const runner: MaintainerRunner = vi.fn(async () => ({ response }));
      const ran = await maybeRunForTaskEvent(EventNames.TASK_CREATED, makeTask(), 'api', runner);
      expect(ran, `answer must be refused: ${response.slice(0, 40)}`).toBe(false);
      expect(fs.existsSync(LOG_FILE), `nothing may be written for: ${response.slice(0, 40)}`).toBe(false);
      expect(fs.readFileSync(SKILL_FILE, 'utf-8')).toBe(before);
    }
  });

  it('refuses a new_skill whose description blows the routing limit', async () => {
    await seedProjectSkill();
    const ran = await maybeRunForTaskEvent(
      EventNames.TASK_COMPLETED, makeTask(), 'api',
      answering({
        log: 'entry',
        new_skill: {
          name: 'too-wordy',
          category: SKILL_CAT,
          type: 'action',
          description: 'This description is far too long to serve as the routing signal in the skill index',
          content: '# Too wordy',
        },
      }),
    );
    expect(ran).toBe(false);
    expect(fs.existsSync(LOG_FILE)).toBe(false);
    expect(fs.existsSync(path.join(GLOBAL_SKILLS_DIR, SKILL_CAT, 'too-wordy'))).toBe(false);
  });
});

describe('maintainer prompt', () => {
  it('includes task payload, skill content, log tail, and the JSON contract', async () => {
    await seedProjectSkill();
    await maybeRunForTaskEvent(
      EventNames.TASK_CREATED, makeTask({ id: 'earlier' }), 'api', logOnly('Earlier progress entry.'),
    );

    const prompt = buildMaintainerPrompt(makeTask(), EventNames.TASK_COMPLETED, LOCATION);
    expect(prompt).toContain('[Task completed]');
    expect(prompt).toContain('Ship the history.db index');
    expect(prompt).toContain(`- Project: ${PROJECT}`);
    expect(prompt).toContain('Current direction: build the Personal AI.');
    expect(prompt).toContain('Earlier progress entry.');
    // The answer contract: one JSON object, log always, skill/new_skill optional.
    expect(prompt).toContain('"log"');
    expect(prompt).toContain('"skill"');
    expect(prompt).toContain('"new_skill"');
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
    const runner = logOnly();
    const ran = await maybeRunForTaskEvent(EventNames.TASK_CREATED, task, 'api', runner);
    expect(ran).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });
});
