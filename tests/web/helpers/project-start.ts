/**
 * The shared data of the project-first start tests (draft-project-start.test.ts,
 * draft-work-in.test.ts): a draft, a git source (Marina on a remote box) and a plugin
 * source with an array input (Acme's packages on this computer).
 */
import type { StartSource } from '@/api/projects';
import type { DraftColumn } from '@/components/sessions/draft-column';

export function draft(over: Partial<DraftColumn> = {}): DraftColumn {
  return { id: 'draft:t-1', cwd: '/home/u', host: null, meta: {} as DraftColumn['meta'], ...over };
}

export const git: StartSource = {
  provider: 'git-worktree', provider_name: 'Git worktree', anchor: '/repos/marina', host: 'big-box', host_label: 'Big box',
  inputs: {}, suggestions: {},
};
export const plugin: StartSource = {
  provider: 'fake-multirepo', provider_name: 'Fake multi-repo', anchor: '/ws/multi', host: '__local__', host_label: 'This computer',
  inputs: { packages: ['Alpha', 'Beta'], mode: 'fresh' },
  suggestions: { packages: ['Alpha', 'Beta', 'Gamma', 'Delta'] },
  input_schema: {
    type: 'object',
    properties: { packages: { type: 'array', title: 'Packages' }, mode: { type: 'string', enum: ['fresh', 'local'] } },
    required: ['packages'],
  },
};
