/**
 * Plugin status items (the live rings above Voice in the rail): pure helpers, no React.
 *
 * The server sends the whole list on every change (`plugin:status-items`), already
 * validated. This side still degrades instead of throwing: an older server sends
 * nothing, a newer one may send a tone or glyph this build does not know, and neither
 * may break the rail. Time is ticked HERE from `timer`, never by a message per minute.
 */
import type { NotificationAction } from '@/contexts/notifications/types';

export type StatusItemTone = 'neutral' | 'accent' | 'success' | 'warning';
export type StatusItemGlyph = 'check' | 'alert' | 'stand' | 'pause';

export interface StatusItemAction extends NotificationAction {
  kind: 'op';
  pluginId: string;
  op: string;
  primary: boolean;
}

export interface StatusItem {
  key: string;
  pluginId: string;
  pluginName: string;
  id: string;
  title: string;
  detail?: string;
  tone: StatusItemTone;
  timer?: { startedAt: number; endsAt: number; mode: 'fill' | 'drain' };
  glyph?: StatusItemGlyph;
  actions: StatusItemAction[];
  app?: string;
}

const TONES = new Set<string>(['neutral', 'accent', 'success', 'warning']);
const GLYPHS = new Set<string>(['check', 'alert', 'stand', 'pause']);
const MAX_ACTIONS = 3;
const MINUTE_MS = 60_000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function actionOf(raw: unknown): StatusItemAction | null {
  if (!isPlainObject(raw) || raw.kind !== 'op') return null;
  const label = str(raw.label);
  const pluginId = str(raw.pluginId);
  const op = str(raw.op);
  if (!label || !pluginId || !op) return null;
  return {
    kind: 'op', label, pluginId, op, primary: raw.primary === true,
    ...(isPlainObject(raw.args) ? { args: raw.args } : {}),
  };
}

function itemOf(raw: unknown): StatusItem | null {
  if (!isPlainObject(raw)) return null;
  const key = str(raw.key);
  const pluginId = str(raw.pluginId);
  const title = str(raw.title);
  if (!key || !pluginId || !title) return null;
  let timer: StatusItem['timer'];
  if (isPlainObject(raw.timer)) {
    const { startedAt, endsAt, mode } = raw.timer;
    if (typeof startedAt === 'number' && typeof endsAt === 'number' && Number.isFinite(startedAt) && endsAt > startedAt) {
      timer = { startedAt, endsAt, mode: mode === 'fill' ? 'fill' : 'drain' };
    }
  }
  const actions = Array.isArray(raw.actions)
    ? raw.actions.map(actionOf).filter((a): a is StatusItemAction => a !== null).slice(0, MAX_ACTIONS)
    : [];
  const detail = str(raw.detail);
  const app = str(raw.app);
  return {
    key,
    pluginId,
    pluginName: str(raw.pluginName) || pluginId,
    id: str(raw.id),
    title,
    ...(detail ? { detail } : {}),
    tone: TONES.has(raw.tone as string) ? raw.tone as StatusItemTone : 'neutral',
    ...(timer ? { timer } : {}),
    ...(GLYPHS.has(raw.glyph as string) ? { glyph: raw.glyph as StatusItemGlyph } : {}),
    actions,
    ...(app ? { app } : {}),
  };
}

/** The wire `{ items }` → the items the rail draws, in the server's order. */
export function statusItemsOf(raw: unknown): StatusItem[] {
  const list = isPlainObject(raw) ? raw.items : null;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: StatusItem[] = [];
  for (const one of list) {
    const item = itemOf(one);
    if (!item || seen.has(item.key)) continue;
    seen.add(item.key);
    out.push(item);
  }
  return out;
}

/** Milliseconds left on the timer, never negative; null without a timer. */
export function remainingMs(item: Pick<StatusItem, 'timer'>, now: number): number | null {
  if (!item.timer) return null;
  return Math.max(0, item.timer.endsAt - now);
}

/** How much of the ring is drawn, 0..1. No timer draws it full. */
export function ringFraction(item: Pick<StatusItem, 'timer'>, now: number): number {
  const t = item.timer;
  if (!t) return 1;
  const total = t.endsAt - t.startedAt;
  const done = Math.min(1, Math.max(0, (now - t.startedAt) / total));
  return t.mode === 'fill' ? done : 1 - done;
}

/** "12 min", "1 h", "1 h 5 min". Rounded UP, so a timer reads "1 min" until it ends. */
export function formatRemaining(ms: number): string {
  const minutes = Math.ceil(Math.max(0, ms) / MINUTE_MS);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** The ring's centre: minutes left ("12", "2h"), or '' when a glyph or no timer fills it. */
export function ringText(item: Pick<StatusItem, 'timer' | 'glyph'>, now: number): string {
  if (item.glyph) return '';
  const left = remainingMs(item, now);
  if (left === null) return '';
  const minutes = Math.ceil(left / MINUTE_MS);
  return minutes >= 60 ? `${Math.round(minutes / 60)}h` : String(minutes);
}

/** The title with `{remaining}` filled in; without a timer the placeholder drops out. */
export function itemTitle(item: Pick<StatusItem, 'title' | 'timer'>, now: number): string {
  if (!item.title.includes('{remaining}')) return item.title;
  const left = remainingMs(item, now);
  const filled = item.title.split('{remaining}').join(left === null ? '' : formatRemaining(left));
  return filled.replace(/\s{2,}/g, ' ').trim();
}

/** Primary first, then the rest in the plugin's order. */
export function orderedActions(item: Pick<StatusItem, 'actions'>): StatusItemAction[] {
  return [...item.actions.filter((a) => a.primary), ...item.actions.filter((a) => !a.primary)];
}
