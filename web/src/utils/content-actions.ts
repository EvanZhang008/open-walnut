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
 *     give me an input box"). The box's To row picks who reads it: the CEO (the default), a router
 *     or any VP (2026-11-16, the user: "talk to router, talk to COE ... or talk to any VP by
 *     selection"). Send posts both, with any pictures the person added
 *     (`POST /api/v1/content/ceo { item, note, images?, to? }`); the
 *     server puts their words, then the framed item, into that node's chat as their message;
 *     a toast says so and opens that chat.
 *   - New task: the home page's draft column opens with the title and context filled in and the
 *     caret after them (MainPage hears CONTENT_NEW_TASK_EVENT). The person writes the prompt,
 *     picks project and host, and presses Send; until then nothing exists on the server.
 *
 * The box, the toast and the navigation need the app shell; ContentActionsHost registers them.
 */
import { newTaskDraftText, normalizeContentItem, type ContentItem } from '@open-walnut/content-item';
import { fullTime } from '@/utils/time';
import { apiGet, apiPost } from '@/api/client';
import type { ImageAttachment } from '@/api/chat';
import { openSessionOnHome } from '@/utils/open-session';
import { log } from '@/utils/log';
import type { ToastReason } from '@/contexts/notifications/types';

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
  talk_to_ceo: { label: 'Talk to CEO', description: 'Write to the CEO, a VP or a router, with this attached' },
  new_task: { label: 'New task', description: 'Open a new task draft with this filled in' },
};

export interface ContentToast {
  severity: 'success' | 'warning' | 'error';
  /** A failure, or a send that landed in a chat out of sight (the UI standard's toast rule). */
  toastReason: ToastReason;
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

/** One node of the org the box writes to (GET /api/v1/content/targets). */
export interface ContentTarget {
  id: string;
  kind: 'ceo' | 'vp' | 'router';
  name: string;
  /** A router's area (the Mail reader's Ask router picks the router of the mail's area). */
  areaId?: string;
}

/** Who the box opens addressed to: a node by id, or the router of an area. Absent: the CEO. */
export type ContentTargetPick = { id: string } | { areaId: string };

/** The CEO before the org answers (and when it cannot): the box always has someone to write to. */
export const CEO_TARGET: ContentTarget = { id: 'main', kind: 'ceo', name: 'CEO' };

/** One open Talk to CEO box. `done` says whether it was sent. */
export interface CeoComposerRequest {
  item: ContentItem;
  anchor: ContentAnchor | null;
  /** The button it was opened from: a press on it closes the box instead of reopening it. */
  owner?: HTMLElement | null;
  /** Who it opens addressed to; the person can pick another in the box. */
  to?: ContentTargetPick;
  done(sent: boolean): void;
}

/** The org changes rarely; a box opened twice in a minute asks once. */
const TARGETS_FRESH_MS = 60_000;
let targetsCache: { at: number; list: Promise<ContentTarget[]> } | null = null;

/** The CEO, the routers and the VPs; the CEO alone when the server cannot say. */
export function fetchContentTargets(): Promise<ContentTarget[]> {
  if (targetsCache && Date.now() - targetsCache.at < TARGETS_FRESH_MS) return targetsCache.list;
  const list = apiGet<{ targets?: ContentTarget[] }>('/api/v1/content/targets', undefined, { quietStatuses: [501], timeoutMs: 8_000 })
    .then((body) => {
      const targets = Array.isArray(body?.targets) ? body.targets.filter((t) => t && typeof t.id === 'string' && typeof t.name === 'string') : [];
      targetsKnown = targets.length > 0 ? targets : [CEO_TARGET];
      return targetsKnown;
    })
    .catch((err: unknown) => {
      log.warn('content-actions', 'talk to targets not read', { error: errorWords(err) });
      targetsCache = null;
      return [CEO_TARGET];
    });
  targetsCache = { at: Date.now(), list };
  return list;
}

/** What the box knew last, so a box opened again starts on the real list rather than the CEO alone. */
export function cachedContentTargets(): ContentTarget[] | null {
  return targetsKnown;
}
let targetsKnown: ContentTarget[] | null = null;

/** The router that decides for an area, if the org has one. Never another area's. */
export function routerOfArea(targets: readonly ContentTarget[], areaId: string): ContentTarget | undefined {
  return targets.find((t) => t.kind === 'router' && t.areaId === areaId);
}

/**
 * The target a box opens on: the one asked for, else the CEO. An area with no router of its own
 * opens on the CEO, never on another area's router.
 */
export function pickTarget(targets: readonly ContentTarget[], to?: ContentTargetPick): ContentTarget {
  const ceo = targets.find((t) => t.kind === 'ceo') ?? CEO_TARGET;
  if (!to) return ceo;
  if ('id' in to) return targets.find((t) => t.id === to.id) ?? ceo;
  return routerOfArea(targets, to.areaId) ?? ceo;
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
  /** The node it reached (an older server sends none: the CEO). */
  to?: { id: string; kind: ContentTarget['kind']; name: string };
}

/** That node's chat (Main's in the chat slot); a test run's stand-in in its own column. */
function openCeoChat(answer: CeoAnswer): void {
  if (answer.testRun && answer.sessionId) {
    openSessionOnHome(answer.sessionId, navigate);
    return;
  }
  const taskId = answer.to && answer.to.kind !== 'ceo' ? answer.to.id : 'main';
  window.dispatchEvent(new CustomEvent('org:chat', { detail: { taskId } }));
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
export function openCeoComposer(raw: ContentItem, anchor?: ContentAnchor | null, owner?: HTMLElement | null, to?: ContentTargetPick): Promise<boolean> {
  const item = itemOf(raw);
  if (!runtime) return Promise.reject(new Error('Talk to CEO is not ready yet'));
  const at = anchor === undefined ? recentPointer() : anchor;
  return new Promise<boolean>((resolve) => {
    runtime!.composer({ item, anchor: at, owner, ...(to ? { to } : {}), done: resolve });
    log.info('content-actions', 'talk to ceo box opened', { source: item.source, anchored: !!at, to: to ? ('id' in to ? to.id : `area:${to.areaId}`) : 'ceo' });
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

/** "the CEO", "Walnut VP", "Personal mail router": how a sentence names the node. */
export function targetWords(target: Pick<ContentTarget, 'kind' | 'name'>): string {
  return target.kind === 'ceo' ? 'the CEO' : target.name;
}

/**
 * Send: the person's words, their pictures (as a chat send carries them) and the item to the CEO,
 * or to the VP or router picked in the box. Throws (after its toast) when not sent.
 */
export async function sendToCeo(raw: ContentItem, note: string, images: readonly ImageAttachment[] = [], target: ContentTarget = CEO_TARGET): Promise<void> {
  const item = itemOf(raw);
  const words = note.trim();
  const who = targetWords(target);
  if (!words) throw new Error(`Write what you want to tell ${who}`);
  let answer: CeoAnswer;
  try {
    const pictures = images.filter((img) => img.data).map(({ data, mediaType }) => ({ data, mediaType }));
    answer = await apiPost<CeoAnswer>('/api/v1/content/ceo', { item, note: words, ...(pictures.length > 0 ? { images: pictures } : {}), ...(target.kind !== 'ceo' ? { to: target.id } : {}) }, { timeoutMs: 30_000 });
  } catch (err) {
    log.warn('content-actions', 'talk to ceo failed', { source: item.source, to: target.id, error: errorWords(err) });
    runtime?.toast({ severity: 'error', toastReason: 'failure', title: `Not sent to ${who}`, body: errorWords(err), dedupKey: `content-ceo-error:${item.title}` });
    throw err;
  }
  log.info('content-actions', 'talk to ceo sent', { source: item.source, to: answer.to?.id ?? 'main', images: images.length, taskId: answer.taskId, sessionId: answer.sessionId, held: !!answer.held, testRun: !!answer.testRun });
  runtime?.toast(answer.held
    ? {
      severity: 'warning', toastReason: 'failure', title: `Not sent: ${who} is waiting on your answer`,
      body: 'Answer it in that chat, then send this again.',
      action: { label: 'Open chat', run: () => openCeoChat(answer) }, dedupKey: `content-ceo:${item.title}`,
    }
    : {
      severity: 'success', toastReason: 'out-of-sight', title: answer.testRun ? `Sent to the stand-in for ${who} (test run)` : `Sent to ${who}`, body: item.title,
      action: { label: 'Open chat', run: () => openCeoChat(answer) }, dedupKey: `content-ceo:${item.title}`,
    });
  if (answer.held) throw new Error(`${who === 'the CEO' ? 'The CEO' : who} is waiting on your answer`);
}

/** The draft text "New task" fills in (also what a test reads back). */
export function contentDraftText(raw: ContentItem): string {
  // The draft keeps its words: a whole time, never "today", which goes stale.
  return newTaskDraftText(itemOf(raw), (iso) => fullTime(iso) || iso);
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
