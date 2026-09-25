/**
 * The draft of an "ask about this object" drawer (web/src/components/chat/ask-object-draft.ts).
 *
 * Asked for on 2026-09-25: the drawer defaults to Ask Walnut, can switch to Start Task with its own
 * folder and host, the new task starts in Focus, and More edits the task fields. What is pinned here:
 *   . the row opens as Ask Walnut through the same transition the tab uses, so Start Task restores a
 *     plain Home draft (no folder, Inbox, Focus) and switching back re-seeds the Ask Walnut project;
 *   . the launch body in each mode (walnut flag and project vs folder, host, engine, project);
 *   . the tier: Focus by default, a More pick rides the launch, an unpin says null, a deleted custom
 *     tier degrades to Focus;
 *   . "Create task for later" files the text with the object's context in the description.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../web/src/utils/log', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import { askLaunchBody, askTaskForLater, initialAskDraft } from '../../web/src/components/chat/ask-object-draft';
import {
  applyDraftPathPick, applyDraftTaskFieldEdit, enterWalnutDraft, leaveWalnutDraft, makeTierKnown,
} from '../../web/src/components/sessions/draft-ownership';
import { DEFAULT_ENGINE_CATALOG } from '../../web/src/utils/engines';
import type { DraftColumn } from '../../web/src/components/sessions/draft-column';

const ID = 'ask-object:general:mail:["fixture:a","INBOX:1:31"]';
const TIERS = makeTierKnown([], true);
const MESSAGE = '[Mail you are asking about]\nFrom: Keeper Reports\n[/Mail you are asking about]\n\nQ';

function body(draft: DraftColumn, agentId = 'general') {
  return askLaunchBody({ draft, agentId, message: MESSAGE, tierKnown: TIERS, catalog: DEFAULT_ENGINE_CATALOG });
}

function inFolder(draft: DraftColumn, cwd: string, host: string | null = null): DraftColumn {
  return applyDraftPathPick(draft, { cwd, host }, draft.meta, undefined, () => '');
}

describe('the row a drawer opens on', () => {
  it('is Ask Walnut, filed under Ask Walnut, in Focus', () => {
    const draft = initialAskDraft(ID);
    expect(draft.walnut).toBe(true);
    expect(draft.project).toBe('Ask Walnut');
    expect(draft.meta.pinTier).toBe('focus');
    expect(draft.cwd).toBe('');
  });

  it('switches to a plain Start Task row and back without losing the Ask Walnut project', () => {
    const task = leaveWalnutDraft(initialAskDraft(ID));
    expect(task.walnut).toBe(false);
    expect(task.project ?? '').toBe('');
    expect(task.meta.pinTier).toBe('focus');
    const back = enterWalnutDraft(task);
    expect(back.project).toBe('Ask Walnut');
  });
});

describe('the launch in Ask Walnut mode', () => {
  it('is a walnut launch with no cwd, the Ask Walnut project and a Focus tier', () => {
    const launch = body(initialAskDraft(ID));
    expect(launch).toMatchObject({ cwd: '', message: MESSAGE, walnutAgent: true, project: 'Ask Walnut' });
    expect(launch.taskMeta?.pinTier).toBe('focus');
    expect(launch).not.toHaveProperty('engine');
    expect(launch).not.toHaveProperty('host');
  });

  it('names another console agent instead of a project', () => {
    const launch = body(initialAskDraft(ID), 'mentor');
    expect(launch.agentId).toBe('mentor');
    expect(launch).not.toHaveProperty('project');
  });
});

describe('the launch in Start Task mode', () => {
  it('runs in the picked folder and host, with the project the folder gave it', () => {
    const draft = inFolder(leaveWalnutDraft(initialAskDraft(ID)), '/work/marina-app', 'devbox');
    const launch = body(draft);
    expect(launch).toMatchObject({ cwd: '/work/marina-app', host: 'devbox', message: MESSAGE });
    expect(launch).not.toHaveProperty('walnutAgent');
    expect(launch.taskMeta?.pinTier).toBe('focus');
    // The folder named the project, so the server may remember the folder for a new project row.
    expect(launch.project).toBe('marina-app');
    expect(launch.projectFromFolder).toBe(true);
  });

  it('keeps a project the person picked, and does not claim the folder named it', () => {
    const picked = { ...inFolder(leaveWalnutDraft(initialAskDraft(ID)), '/work/marina-app'), project: 'Harbour', projectSource: 'user' as const };
    const launch = body(picked);
    expect(launch.project).toBe('Harbour');
    expect(launch).not.toHaveProperty('projectFromFolder');
  });

  it('drops a local-only engine on a remote host, and the model picked under it', () => {
    const base = inFolder(leaveWalnutDraft(initialAskDraft(ID)), '/work/marina-app', 'devbox');
    const draft = { ...base, meta: { ...base.meta, engine: 'codex' as const, model: 'codex-model' } };
    const launch = body(draft);
    expect(launch.engine).toBeUndefined();
    expect(launch.model).toBeUndefined();
    // The same pick on this machine rides as is.
    const local = body({ ...draft, host: null });
    expect(local.engine).toBe('codex');
    expect(local.model).toBe('codex-model');
  });
});

describe('the tier, from More', () => {
  it('carries a picked tier, says null for an unpin, and degrades a deleted custom tier to Focus', () => {
    const draft = initialAskDraft(ID);
    expect(body(applyDraftTaskFieldEdit(draft, { pinTier: 'satellite' })).taskMeta?.pinTier).toBe('satellite');
    expect(body(applyDraftTaskFieldEdit(draft, { pinTier: undefined })).taskMeta?.pinTier).toBeNull();
    expect(body(applyDraftTaskFieldEdit(draft, { pinTier: 'ct_gone' })).taskMeta?.pinTier).toBe('focus');
  });
});

describe('a task for later', () => {
  const CONTEXT = 'The mail I am looking at in Walnut:\n\nSubject: Quarterly keeper report\nLink: http://127.0.0.1:3456/mail?x';

  it('takes the first line as the title and keeps the object\'s context in the description', () => {
    const draft = inFolder(leaveWalnutDraft(initialAskDraft(ID)), '/work/marina-app');
    const input = askTaskForLater({ draft, text: 'Reply to the keeper\nBy Friday.', contextBlock: CONTEXT, tierKnown: TIERS });
    expect(input?.title).toBe('Reply to the keeper');
    expect(input?.description).toBe(`By Friday.\n\n${CONTEXT}`);
    expect(input).toMatchObject({ pinned: true, focus_tier: 'focus', priority: 'none' });
    expect(input?.project).toBe('marina-app');
  });

  it('files nothing without a title, and keeps Unicode intact (\\u00e9, \\u4f60\\u597d)', () => {
    const draft = leaveWalnutDraft(initialAskDraft(ID));
    expect(askTaskForLater({ draft, text: '  \nbody', contextBlock: CONTEXT, tierKnown: TIERS })).toBeNull();
    const input = askTaskForLater({ draft, text: 'Caf\u00e9 \u4f60\u597d', contextBlock: '', tierKnown: TIERS });
    expect(input?.title).toBe('Caf\u00e9 \u4f60\u597d');
    expect(input).not.toHaveProperty('description');
  });

  it('says unpinned when More took the tier away', () => {
    const draft = applyDraftTaskFieldEdit(leaveWalnutDraft(initialAskDraft(ID)), { pinTier: undefined });
    expect(askTaskForLater({ draft, text: 'T', contextBlock: '', tierKnown: TIERS })?.pinned).toBe(false);
  });
});
