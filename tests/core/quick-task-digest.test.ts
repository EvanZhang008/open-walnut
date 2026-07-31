import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getStoreCategories: vi.fn(),
  listTasksSlim: vi.fn(),
  getProjectMetadata: vi.fn(),
}));

vi.mock('../../src/core/task-manager.js', () => ({
  getStoreCategories: mocks.getStoreCategories,
  listTasksSlim: mocks.listTasksSlim,
  getProjectMetadata: mocks.getProjectMetadata,
}));

import { buildCategoryDigest } from '../../src/core/quick-task-digest.js';

interface FixtureTask {
  title: string;
  category: string;
  project?: string;
  phase: string;
  updated_at?: string;
}

function task(
  title: string,
  category: string,
  project: string | undefined = category,
  phase = 'TODO',
): FixtureTask {
  return { title, category, project, phase, updated_at: '2026-07-23T12:00:00.000Z' };
}

function categories(names: string[]): Record<string, { source: string }> {
  return Object.fromEntries(names.map((name) => [name, { source: 'local' }]));
}

describe('buildCategoryDigest', () => {
  beforeEach(() => {
    mocks.getStoreCategories.mockReset();
    mocks.listTasksSlim.mockReset();
    mocks.getProjectMetadata.mockReset();
    mocks.getStoreCategories.mockResolvedValue({});
    mocks.listTasksSlim.mockResolvedValue([]);
    mocks.getProjectMetadata.mockResolvedValue(null);
  });

  it('appends the maintained project summary as an "about:" line under the project', async () => {
    mocks.getStoreCategories.mockResolvedValue(categories(['Work']));
    mocks.listTasksSlim.mockResolvedValue([
      task('Update homepage', 'Work', 'Website'),
    ]);
    mocks.getProjectMetadata.mockImplementation(async (_cat: string, project: string) =>
      project === 'Website' ? { summary: 'Marketing site revamp: new landing page and SEO.' } : null);

    const { digest } = await buildCategoryDigest();

    expect(digest).toContain('  - Website: "Update homepage"');
    expect(digest).toContain('    about: Marketing site revamp: new landing page and SEO.');
  });

  it('groups default-project titles on category lines and named projects below them', async () => {
    mocks.getStoreCategories.mockResolvedValue(categories(['Personal', 'Work']));
    mocks.listTasksSlim.mockResolvedValue([
      task('Buy groceries', 'Personal'),
      task('Call dentist', 'Personal', undefined),
      task('Pick up parcel', 'Personal', 'Errands'),
      task('Update homepage', 'Work', 'Website'),
    ]);

    const result = await buildCategoryDigest();

    expect(result.digest).toBe([
      '- Personal (3 open tasks): "Buy groceries"; "Call dentist"',
      '  - Errands: "Pick up parcel"',
      '- Work (1 open tasks)',
      '  - Website: "Update homepage"',
    ].join('\n'));
    expect(result.categories).toEqual(['Personal', 'Work']);
    expect(result.projectsByCategory).toEqual({ Personal: ['Errands'], Work: ['Website'] });
    expect(mocks.listTasksSlim).toHaveBeenCalledWith({ minimal: true });
  });

  it('caps titles and displayed projects while preserving full project allowlists', async () => {
    const longTitle = '𠀀'.repeat(41);
    mocks.getStoreCategories.mockResolvedValue(categories(['Personal']));
    mocks.listTasksSlim.mockResolvedValue([
      task(longTitle, 'Personal'),
      task('Second title', 'Personal'),
      task('Third title', 'Personal'),
      task('Fourth title', 'Personal'),
      task('Project one task', 'Personal', 'Project One'),
      task('Project two task', 'Personal', 'Project Two'),
      task('Project three task', 'Personal', 'Project Three'),
      task('Project four task', 'Personal', 'Project Four'),
      task('Project five task', 'Personal', 'Project Five'),
    ]);

    const result = await buildCategoryDigest();
    const lines = result.digest.split('\n');

    expect(Array.from(lines[0].match(/"([^"]+)"/)![1])).toHaveLength(40);
    expect(lines[0]).toContain('"Second title"; "Third title"');
    expect(lines[0]).not.toContain('Fourth title');
    expect(lines.filter((line) => line.startsWith('  - '))).toHaveLength(4);
    expect(result.digest).not.toContain('  - Project Five:');
    expect(result.projectsByCategory.Personal).toEqual([
      'Project One', 'Project Two', 'Project Three', 'Project Four', 'Project Five',
    ]);
  });

  it('skips metadata task rows', async () => {
    mocks.getStoreCategories.mockResolvedValue(categories(['Personal']));
    mocks.listTasksSlim.mockResolvedValue([
      task('.metadata project record', 'Hidden', 'Setup'),
      task('Call clinic', 'Personal'),
    ]);

    const result = await buildCategoryDigest();

    expect(result.digest).toBe('- Personal (1 open tasks): "Call clinic"');
    expect(result.categories).toEqual(['Personal']);
    expect(result.projectsByCategory).toEqual({ Personal: [] });
  });

  it('caps the digest at 15 categories by open count without capping allowlists', async () => {
    const names = Array.from({ length: 16 }, (_, index) => `Category ${index + 1}`);
    const tasks: FixtureTask[] = [];
    names.forEach((name, index) => {
      for (let count = 0; count <= index; count += 1) {
        tasks.push(task(`${name} task ${count + 1}`, name, `Project ${index + 1}`));
      }
    });
    mocks.getStoreCategories.mockResolvedValue(categories(names));
    mocks.listTasksSlim.mockResolvedValue(tasks);

    const result = await buildCategoryDigest();

    expect(result.digest.match(/^- Category /gm)).toHaveLength(15);
    expect(result.digest).toContain('- Category 16 (16 open tasks)');
    expect(result.digest).not.toContain('- Category 1 (1 open tasks)');
    expect(result.categories).toHaveLength(16);
    expect(result.projectsByCategory['Category 1']).toEqual(['Project 1']);
    expect(result.projectsByCategory['Category 16']).toEqual(['Project 16']);
  });

  it('truncates at 4000 characters on a whole-line boundary with a marker', async () => {
    const names = Array.from({ length: 15 }, (_, index) => `Long Category ${index + 1} ${'x'.repeat(40)}`);
    const tasks: FixtureTask[] = [];
    for (const name of names) {
      tasks.push(task(`Default ${'a'.repeat(80)}`, name));
      for (let project = 1; project <= 4; project += 1) {
        for (let title = 1; title <= 3; title += 1) {
          tasks.push(task(
            `Recent task ${title} ${'b'.repeat(80)}`,
            name,
            `Project ${project} ${'p'.repeat(40)}`,
          ));
        }
      }
    }
    mocks.getStoreCategories.mockResolvedValue(categories(names));
    mocks.listTasksSlim.mockResolvedValue(tasks);

    const result = await buildCategoryDigest();
    const lines = result.digest.split('\n');

    expect(result.digest.length).toBeLessThanOrEqual(4000);
    expect(lines.at(-1)).toBe('…');
    expect(lines.slice(0, -1).every((line) =>
      line.startsWith('- Long Category') || line.startsWith('  - Project')
    )).toBe(true);
  });

  it('returns empty output for an empty store', async () => {
    await expect(buildCategoryDigest()).resolves.toEqual({
      digest: '', categories: [], projectsByCategory: {},
    });
  });
});
