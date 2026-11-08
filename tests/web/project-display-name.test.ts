/**
 * The project name a person reads vs the name Walnut stores. An agent's asks are
 * still filed under `Ask <agent>` projects (stored data, the registry, the API),
 * while every web surface that prints a project shows them as "Quick question"
 * (projectDisplayName, built on askProjectDisplay). These pin the shared points
 * the board, menus, filters and pills draw through: the text changes, the value
 * a click, filter or move sends does not.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createElement as h } from '../../web/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../web/node_modules/react-dom/server.node.js';
import { projectDisplayName, taskProjectLabel } from '../../web/src/utils/project-display';
import { RowProjectName } from '../../web/src/components/tasks/RowProjectName';
import { projectLabel, valueLabel, dimValues, valueTitle } from '../../web/src/components/tasks/filter-bar-model';
import { DEFAULT_FILTER_STATE, type FilterLists } from '../../web/src/components/tasks/filter-bar-types';
import { buildFolderMenuItems } from '../../web/src/components/tasks/folder-menu-items';
import { draftProjectChip } from '../../web/src/components/sessions/draft-project-chip';
import type { DraftColumn } from '../../web/src/components/sessions/draft-column';
import { lookupTaskLabel, resetEntityLabelsForTesting, syncTasks } from '../../web/src/stores/entity-label-store';

const GENERAL = 'Ask Walnut';
const MENTOR = 'Ask Mentor';

const lists: FilterLists = {
  loading: false,
  projects: ['', GENERAL, MENTOR, 'Garden'],
  sources: [],
  tags: [],
  sprints: [],
  showPriority: true,
  tagLabel: (t) => t,
};

describe('projectDisplayName', () => {
  it('reads the Ask projects as Quick question and leaves every other name alone', () => {
    expect(projectDisplayName(GENERAL)).toBe('Quick question');
    expect(projectDisplayName(MENTOR)).toBe('Quick question \u00b7 Mentor');
    expect(projectDisplayName('Garden')).toBe('Garden');
    expect(projectDisplayName('')).toBe('Inbox');
    expect(projectDisplayName(undefined)).toBe('Inbox');
  });
});

describe('row project name', () => {
  it('prints the display name and keeps the stored name on data-project', () => {
    const html = renderToStaticMarkup(h(RowProjectName, { project: GENERAL, className: 'x', onFilter: () => {} }));
    expect(html).toContain('data-project="Ask Walnut"');
    expect(html).toContain('>Quick question</button>');
    expect(html).toContain('title="Show every task in Quick question"');
  });

  it('a plain span shows the agent name too', () => {
    const html = renderToStaticMarkup(h(RowProjectName, { project: MENTOR, className: 'x' }));
    expect(html).toBe('<span class="x">Quick question \u00b7 Mentor</span>');
  });
});

describe('filter bar labels', () => {
  it('labels the project values by display name and keeps the stored value', () => {
    expect(projectLabel(GENERAL)).toBe('Quick question');
    expect(valueLabel('project', MENTOR, lists)).toBe('Quick question \u00b7 Mentor');
    expect(valueTitle('project', GENERAL, lists)).toBe('Tasks in Quick question');
    const options = dimValues('project', DEFAULT_FILTER_STATE, lists);
    const general = options.find((o) => o.value === GENERAL);
    expect(general).toMatchObject({ value: GENERAL, label: 'Quick question' });
    expect(options.find((o) => o.value === 'Garden')?.label).toBe('Garden');
    expect(options.find((o) => o.value === '')?.label).toBe('Inbox');
  });
});

describe('folder menu project row', () => {
  it('shows the display name of the owning project', () => {
    const items = buildFolderMenuItems({ groupId: 'g1', label: 'Notes', project: GENERAL }, { onMoveToProject: () => {} }, () => {});
    expect(items.find((i) => i.key === 'move-project')?.value).toBe('Quick question');
  });
});

describe('draft project chip', () => {
  it('a bound draft in an Ask project names it by display name', () => {
    const draft = { id: 'draft:t-1', cwd: '', host: null, meta: {}, taskId: 't-1', project: MENTOR } as unknown as DraftColumn;
    const chip = draftProjectChip(draft, { isKnownProject: () => true, hasMenu: true });
    expect(chip?.name).toBe('Quick question \u00b7 Mentor');
    expect(chip?.title).toContain('filed under Quick question \u00b7 Mentor');
  });
});

describe('task pill hover project', () => {
  beforeEach(() => resetEntityLabelsForTesting());

  it('carries the display name, not the stored one', () => {
    syncTasks([
      { id: 'mvq1a2b3-0001', title: 'Plan the trip', project: GENERAL },
      { id: 'mvq1a2b3-0002', title: 'Water plants', project: 'Garden' },
      { id: 'mvq1a2b3-0003', title: 'Loose', project: '' },
    ]);
    expect(lookupTaskLabel('mvq1a2b3-0001')?.project).toBe('Quick question');
    expect(lookupTaskLabel('mvq1a2b3-0002')?.project).toBe('Garden');
    expect(lookupTaskLabel('mvq1a2b3-0003')?.project).toBeUndefined();
  });
});

describe('the place a task is shown to live', () => {
  it('names the main task as Org and any other task by its project display name', () => {
    expect(taskProjectLabel({ project: GENERAL, org_role: 'main' })).toBe('Org');
    expect(taskProjectLabel({ project: GENERAL })).toBe('Quick question');
    expect(taskProjectLabel({ project: MENTOR })).toBe('Quick question \u00b7 Mentor');
    expect(taskProjectLabel({ project: '' })).toBe('Inbox');
    expect(taskProjectLabel({ project: 'Garden', org_role: 'lead' })).toBe('Garden');
  });
});
