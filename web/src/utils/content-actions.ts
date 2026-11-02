/**
 * The two things Walnut offers on one piece of content anywhere in the app (an email in Mail or
 * in an Inbox letter, a message in a plugin's App): Talk to CEO and New task. One definition,
 * used by Walnut's own surfaces and handed to plugins as `walnut.content`
 * (plugins/host-api.ts), so no surface makes a task out of content on its own (2026-11-02, the
 * user: a mail reminder became a task titled with the subject and the raw mail pasted in, in the
 * Inbox; "talk to ceo, and create a new task ... I can put init prompt").
 *
 *   - Talk to CEO: the server builds the message from the item and sends it into the main
 *     agent's chat as the person's message (`POST /api/v1/content/ceo`); a toast says so and
 *     opens that chat.
 *   - New task: the home page's draft column opens with the title and context filled in
 *     (MainPage hears CONTENT_NEW_TASK_EVENT). The person writes the prompt, picks project and
 *     host, and presses Send; until then nothing exists on the server.
 *
 * The toast and the navigation need the app shell; ContentActionsHost registers them here.
 */
import { newTaskDraftText, normalizeContentItem, type ContentItem } from '@open-walnut/content-item';
import { apiPost } from '@/api/client';
import { openSessionOnHome } from '@/utils/open-session';
import { log } from '@/utils/log';

export type { ContentItem };

export type ContentActionId = 'talk_to_ceo' | 'new_task';

export interface ContentAction {
  id: ContentActionId;
  label: string;
  description: string;
  run(): Promise<void>;
}

/** MainPage opens a draft column seeded with `text` when it hears this. */
export const CONTENT_NEW_TASK_EVENT = 'content:new-task-draft';

export interface ContentNewTaskDetail {
  text: string;
}

export const CONTENT_ACTION_WORDS: Record<ContentActionId, { label: string; description: string }> = {
  talk_to_ceo: { label: 'Talk to CEO', description: 'Send this to the CEO chat with its context' },
  new_task: { label: 'New task', description: 'Open a new task draft with this filled in' },
};

export interface ContentToast {
  severity: 'success' | 'warning' | 'error';
  title: string;
  body?: string;
  action?: { label: string; run(): void };
  dedupKey: string;
}

interface Runtime {
  toast(t: ContentToast): void;
  navigate(to: string): void;
}

let runtime: Runtime | null = null;

/** The app shell's toast and router; returns the unregister. */
export function setContentActionsRuntime(next: Runtime): () => void {
  runtime = next;
  return () => { if (runtime === next) runtime = null; };
}

function navigate(to: string): void {
  if (runtime) runtime.navigate(to);
  else window.location.assign(to);
}

function itemOf(raw: ContentItem): ContentItem {
  const item = normalizeContentItem(raw);
  if (!item) throw new Error('This item has no source or title to hand over');
  return item;
}

interface CeoAnswer {
  taskId: string;
  sessionId: string | null;
  started: boolean;
  held?: boolean;
  testRun?: boolean;
}

/** Main's chat in the chat slot; a test run's stand-in in its own column. */
function openCeoChat(answer: CeoAnswer): void {
  if (answer.testRun && answer.sessionId) {
    openSessionOnHome(answer.sessionId, navigate);
    return;
  }
  window.dispatchEvent(new CustomEvent('org:chat', { detail: { taskId: 'main' } }));
  if (window.location.pathname !== '/') navigate('/');
}

function errorWords(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Walnut did not answer';
}

export async function talkToCeo(raw: ContentItem): Promise<void> {
  const item = itemOf(raw);
  let answer: CeoAnswer;
  try {
    answer = await apiPost<CeoAnswer>('/api/v1/content/ceo', { item }, { timeoutMs: 30_000 });
  } catch (err) {
    log.warn('content-actions', 'talk to ceo failed', { source: item.source, error: errorWords(err) });
    runtime?.toast({ severity: 'error', title: 'Not sent to the CEO', body: errorWords(err), dedupKey: `content-ceo-error:${item.title}` });
    throw err;
  }
  log.info('content-actions', 'talk to ceo sent', { source: item.source, taskId: answer.taskId, sessionId: answer.sessionId, held: !!answer.held, testRun: !!answer.testRun });
  runtime?.toast(answer.held
    ? {
      severity: 'warning', title: 'Not sent: the CEO is waiting on your answer',
      body: 'Answer it in the CEO chat, then send this again.',
      action: { label: 'Open chat', run: () => openCeoChat(answer) }, dedupKey: `content-ceo:${item.title}`,
    }
    : {
      severity: 'success', title: answer.testRun ? 'Sent to the CEO stand-in (test run)' : 'Sent to the CEO', body: item.title,
      action: { label: 'Open chat', run: () => openCeoChat(answer) }, dedupKey: `content-ceo:${item.title}`,
    });
  if (answer.held) throw new Error('The CEO is waiting on your answer');
}

function localTime(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : iso;
}

/** The draft text "New task" fills in (also what a test reads back). */
export function contentDraftText(raw: ContentItem): string {
  return newTaskDraftText(itemOf(raw), localTime);
}

export async function newTaskFromContent(raw: ContentItem): Promise<void> {
  const text = contentDraftText(raw);
  window.dispatchEvent(new CustomEvent<ContentNewTaskDetail>(CONTENT_NEW_TASK_EVENT, { detail: { text } }));
  log.info('content-actions', 'new task draft opened', { source: raw.source });
  if (window.location.pathname !== '/') navigate('/');
}

/** The two choices, in the order Walnut shows them everywhere. */
export function contentActions(item: ContentItem): ContentAction[] {
  return [
    { id: 'talk_to_ceo', ...CONTENT_ACTION_WORDS.talk_to_ceo, run: () => talkToCeo(item) },
    { id: 'new_task', ...CONTENT_ACTION_WORDS.new_task, run: () => newTaskFromContent(item) },
  ];
}
