/**
 * The two things Walnut offers on one piece of content anywhere in the app (an email in Mail or
 * in an Inbox letter, a message in a plugin's App): Talk to CEO and New task. One definition,
 * used by Walnut's own surfaces and handed to plugins as `walnut.content`
 * (plugins/host-api.ts), so no surface makes a task out of content on its own (2026-11-02, the
 * user: a mail reminder became a task titled with the subject and the raw mail pasted in, in the
 * Inbox; "talk to ceo, and create a new task ... I can put init prompt").
 *
 *   - Talk to CEO: a box opens where it was clicked (CeoComposer); the person writes what they
 *     want to tell the CEO, the item rides along as attached context, and nothing is sent until
 *     they press Send (2026-11-03, the user: "I definitely have something to say ... at least
 *     give me an input box"). Send posts both, with any pictures the person added
 *     (`POST /api/v1/content/ceo { item, note, images? }`); the
 *     server puts their words, then the framed item, into the main agent's chat as their message;
 *     a toast says so and opens that chat.
 *   - New task: the home page's draft column opens with the title and context filled in and the
 *     caret after them (MainPage hears CONTENT_NEW_TASK_EVENT). The person writes the prompt,
 *     picks project and host, and presses Send; until then nothing exists on the server.
 *
 * The box, the toast and the navigation need the app shell; ContentActionsHost registers them.
 */
import { newTaskDraftText, normalizeContentItem, type ContentItem } from '@open-walnut/content-item';
import { apiPost } from '@/api/client';
import type { ImageAttachment } from '@/api/chat';
import { openSessionOnHome } from '@/utils/open-session';
import { log } from '@/utils/log';

export type { ContentItem };

export type ContentActionId = 'talk_to_ceo' | 'new_task';

export interface ContentAction {
  id: ContentActionId;
  label: string;
  description: string;
  run(): Promise<unknown>;
}

/** MainPage opens a draft column seeded with `text` when it hears this. */
export const CONTENT_NEW_TASK_EVENT = 'content:new-task-draft';

export interface ContentNewTaskDetail {
  text: string;
}

export const CONTENT_ACTION_WORDS: Record<ContentActionId, { label: string; description: string }> = {
  talk_to_ceo: { label: 'Talk to CEO', description: 'Write to the CEO, with this attached' },
  new_task: { label: 'New task', description: 'Open a new task draft with this filled in' },
};

export interface ContentToast {
  severity: 'success' | 'warning' | 'error';
  title: string;
  body?: string;
  action?: { label: string; run(): void };
  dedupKey: string;
}

/** A viewport point the Talk to CEO box opens at (below and to the right of it). */
export interface ContentAnchor {
  x: number;
  y: number;
}

/** One open Talk to CEO box. `done` says whether it was sent. */
export interface CeoComposerRequest {
  item: ContentItem;
  anchor: ContentAnchor | null;
  /** The button it was opened from: a press on it closes the box instead of reopening it. */
  owner?: HTMLElement | null;
  done(sent: boolean): void;
}

interface Runtime {
  toast(t: ContentToast): void;
  navigate(to: string): void;
  /** Shows the box; a second request replaces an open one (which counts as not sent). */
  composer(req: CeoComposerRequest): void;
  /** Closes the open box, if any, as not sent. */
  closeComposer(): void;
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

/**
 * Where a menu's Talk to CEO opens the box: the point of the click that picked it, when that was
 * a moment ago (a plugin's menu item calls `talkToCeo(item)` with no anchor of its own); else the
 * box opens in the middle of the window.
 */
let lastPointer: { x: number; y: number; at: number } | null = null;
const POINTER_FRESH_MS = 3000;

export function notePointer(x: number, y: number): void {
  lastPointer = { x, y, at: Date.now() };
}

function recentPointer(): ContentAnchor | null {
  return lastPointer && Date.now() - lastPointer.at < POINTER_FRESH_MS ? { x: lastPointer.x, y: lastPointer.y } : null;
}

/** Opens the Talk to CEO box; resolves true once the person sent it, false when they closed it. */
export function openCeoComposer(raw: ContentItem, anchor?: ContentAnchor | null, owner?: HTMLElement | null): Promise<boolean> {
  const item = itemOf(raw);
  if (!runtime) return Promise.reject(new Error('Talk to CEO is not ready yet'));
  const at = anchor === undefined ? recentPointer() : anchor;
  return new Promise<boolean>((resolve) => {
    runtime!.composer({ item, anchor: at, owner, done: resolve });
    log.info('content-actions', 'talk to ceo box opened', { source: item.source, anchored: !!at });
  });
}

export function closeCeoComposer(): void {
  runtime?.closeComposer();
}

/**
 * Talk to CEO from code (a plugin's menu): opens the box at the last click. Resolves true once
 * the person sent it, false when they closed it without sending.
 */
export function talkToCeo(raw: ContentItem): Promise<boolean> {
  return openCeoComposer(raw);
}

/** The longest note the box takes (the server's CEO_NOTE_MAX). */
export const CEO_NOTE_MAX = 8000;

/**
 * Send: the person's words, their pictures (as a chat send carries them) and the item to the CEO.
 * Throws (after its toast) when not sent.
 */
export async function sendToCeo(raw: ContentItem, note: string, images: readonly ImageAttachment[] = []): Promise<void> {
  const item = itemOf(raw);
  const words = note.trim();
  if (!words) throw new Error('Write what you want to tell the CEO');
  let answer: CeoAnswer;
  try {
    const pictures = images.filter((img) => img.data).map(({ data, mediaType }) => ({ data, mediaType }));
    answer = await apiPost<CeoAnswer>('/api/v1/content/ceo', { item, note: words, ...(pictures.length > 0 ? { images: pictures } : {}) }, { timeoutMs: 30_000 });
  } catch (err) {
    log.warn('content-actions', 'talk to ceo failed', { source: item.source, error: errorWords(err) });
    runtime?.toast({ severity: 'error', title: 'Not sent to the CEO', body: errorWords(err), dedupKey: `content-ceo-error:${item.title}` });
    throw err;
  }
  log.info('content-actions', 'talk to ceo sent', { source: item.source, images: images.length, taskId: answer.taskId, sessionId: answer.sessionId, held: !!answer.held, testRun: !!answer.testRun });
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
