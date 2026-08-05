import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getStoreProjects: vi.fn(),
  listTasksSlim: vi.fn(),
  getProjectMetadata: vi.fn(),
}));

vi.mock('../../src/core/task-manager.js', () => ({
  getStoreProjects: mocks.getStoreProjects,
  listTasksSlim: mocks.listTasksSlim,
  getProjectMetadata: mocks.getProjectMetadata,
}));

import { buildProjectDigest, INBOX_LABEL } from '../../src/core/quick-task-digest.js';

interface FixtureTask {
  title: string;
  project?: string;
  phase: string;
  updated_at?: string;
}

function task(title: string, project?: string, phase = 'TODO'): FixtureTask {
  return { title, project, phase, updated_at: '2026-07-23T12:00:00.000Z' };
}

function registry(names: string[]): Record<string, { source: string }> {
  return Object.fromEntries(names.map((name) => [name, { source: 'local' }]));
}

describe('buildProjectDigest', () => {
  beforeEach(() => {
    mocks.getStoreProjects.mockReset();
    mocks.listTasksSlim.mockReset();
    mocks.getProjectMetadata.mockReset();
    mocks.getStoreProjects.mockResolvedValue({});
    mocks.listTasksSlim.mockResolvedValue([]);
    mocks.getProjectMetadata.mockResolvedValue(null);
  });

  it('renders one flat line per project, busiest first', async () => {
    mocks.getStoreProjects.mockResolvedValue(registry(['Errands', 'Website']));
    mocks.listTasksSlim.mockResolvedValue([
      task('Pick up parcel', 'Errands'),
      task('Call dentist', 'Errands'),
      task('Update homepage', 'Website'),
    ]);

    const result = await buildProjectDigest();

    expect(result.digest).toBe([
      '- Errands (2 open tasks): "Pick up parcel"; "Call dentist"',
      '- Website (1 open tasks): "Update homepage"',
    ].join('\n'));
    expect(result.projects).toEqual(['Errands', 'Website']);
    expect(mocks.listTasksSlim).toHaveBeenCalledWith({ minimal: true });
  });

  it('appends the maintained project summary as an "about:" line', async () => {
    mocks.getStoreProjects.mockResolvedValue(registry(['Website']));
    mocks.listTasksSlim.mockResolvedValue([task('Update homepage', 'Website')]);
    mocks.getProjectMetadata.mockImplementation(async (project: string) =>
      project === 'Website' ? { summary: 'Marketing site revamp: new landing page and SEO.' } : null);

    const { digest } = await buildProjectDigest();

    expect(digest).toContain('- Website (1 open tasks): "Update homepage"');
    expect(digest).toContain('  about: Marketing site revamp: new landing page and SEO.');
  });

  it('renders Inbox LAST and keeps it out of the selectable project list', async () => {
    mocks.getStoreProjects.mockResolvedValue(registry(['Website']));
    mocks.listTasksSlim.mockResolvedValue([
      task('Loose thought'),
      task('Another capture', ''),
      task('Update homepage', 'Website'),
    ]);

    const result = await buildProjectDigest();

    expect(result.digest.split('\n')).toEqual([
      '- Website (1 open tasks): "Update homepage"',
      `- ${INBOX_LABEL} — no project (2 open tasks): "Loose thought"; "Another capture"`,
    ]);
    expect(result.projects).toEqual(['Website']);
  });

  it('omits the Inbox line when nothing is unfiled', async () => {
    mocks.getStoreProjects.mockResolvedValue(registry(['Website']));
    mocks.listTasksSlim.mockResolvedValue([task('Update homepage', 'Website')]);

    const { digest } = await buildProjectDigest();
    expect(digest).not.toContain(INBOX_LABEL);
  });

  it('lists a registry project that has no tasks yet (canonical spelling wins)', async () => {
    mocks.getStoreProjects.mockResolvedValue(registry(['Marina']));
    mocks.listTasksSlim.mockResolvedValue([task('Ship it', 'MARINA')]);

    const result = await buildProjectDigest();

    expect(result.projects).toEqual(['Marina']);
    expect(result.digest).toBe('- Marina (1 open tasks): "Ship it"');
  });

  it('caps titles per line at 3 and title length at 40 chars', async () => {
    const longTitle = '𠀀'.repeat(41);
    mocks.getStoreProjects.mockResolvedValue(registry(['Personal']));
    mocks.listTasksSlim.mockResolvedValue([
      task(longTitle, 'Personal'),
      task('Second title', 'Personal'),
      task('Third title', 'Personal'),
      task('Fourth title', 'Personal'),
    ]);

    const { digest } = await buildProjectDigest();

    expect(Array.from(digest.match(/"([^"]+)"/)![1])).toHaveLength(40);
    expect(digest).toContain('"Second title"; "Third title"');
    expect(digest).not.toContain('Fourth title');
  });

  it('skips sentinel .metadata rows left over from the pre-registry model', async () => {
    mocks.getStoreProjects.mockResolvedValue(registry(['Personal']));
    mocks.listTasksSlim.mockResolvedValue([
      task('.metadata_project', 'Setup'),
      task('Call clinic', 'Personal'),
    ]);

    const result = await buildProjectDigest();

    // The sentinel row is skipped before its project is even registered, so
    // neither the title nor the 'Setup' name reaches the digest.
    expect(result.digest).toBe('- Personal (1 open tasks): "Call clinic"');
    expect(result.projects).toEqual(['Personal']);
  });

  it('shows at most 20 projects in the digest while keeping the full allowlist', async () => {
    const names = Array.from({ length: 24 }, (_, index) => `Project ${index + 1}`);
    const tasks: FixtureTask[] = [];
    names.forEach((name, index) => {
      for (let count = 0; count <= index; count += 1) {
        tasks.push(task(`${name} task ${count + 1}`, name));
      }
    });
    mocks.getStoreProjects.mockResolvedValue(registry(names));
    mocks.listTasksSlim.mockResolvedValue(tasks);

    const result = await buildProjectDigest();

    expect(result.digest.match(/^- Project /gm)).toHaveLength(20);
    expect(result.digest).toContain('- Project 24 (24 open tasks)');
    expect(result.digest).not.toContain('- Project 1 (1 open tasks)');
    expect(result.projects).toHaveLength(24);
  });

  it('truncates at 4000 characters on a whole-line boundary with a marker', async () => {
    const names = Array.from({ length: 20 }, (_, index) => `Long Project ${index + 1} ${'x'.repeat(60)}`);
    const tasks: FixtureTask[] = [];
    for (const name of names) {
      for (let title = 1; title <= 3; title += 1) {
        tasks.push(task(`Recent task ${title} ${'b'.repeat(80)}`, name));
      }
    }
    mocks.getStoreProjects.mockResolvedValue(registry(names));
    mocks.listTasksSlim.mockResolvedValue(tasks);

    const result = await buildProjectDigest();
    const lines = result.digest.split('\n');

    expect(result.digest.length).toBeLessThanOrEqual(4000);
    expect(lines.at(-1)).toBe('…');
    expect(lines.slice(0, -1).every((line) => line.startsWith('- Long Project'))).toBe(true);
  });

  it('survives a project-summary read failure (enrichment only)', async () => {
    mocks.getStoreProjects.mockResolvedValue(registry(['Website']));
    mocks.listTasksSlim.mockResolvedValue([task('Update homepage', 'Website')]);
    mocks.getProjectMetadata.mockRejectedValue(new Error('db closed'));

    const { digest } = await buildProjectDigest();
    expect(digest).toBe('- Website (1 open tasks): "Update homepage"');
  });

  it('returns empty output for an empty store', async () => {
    await expect(buildProjectDigest()).resolves.toEqual({ digest: '', projects: [] });
  });
});
