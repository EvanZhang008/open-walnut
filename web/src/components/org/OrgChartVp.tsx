/**
 * One VP card of the org chart (OrgChartSheet.tsx), and the CEO's card above them.
 *
 * Closed, a card is its name and the names of the projects it leads, nothing else (2026-11-06,
 * the user, of cards full of counts, status words, news lines, times, badges and ⋯ menus with
 * every name cut off: "just show the name", "and can expand for more detail"). One quiet sign
 * stays: a dot when the node has something for him, the same rule as its red on the Org list
 * (its threads his view shows; a card with no Threads, what its tasks ask). Opened, the card
 * says what is in it now: its threads, its news and when, its counts, and Open chat and its
 * menu. Each card remembers whether it was open (usePageViewOf, per card).
 */
import type { DragEvent, KeyboardEvent, ReactNode } from 'react';
import { stateCountLabel } from '@open-walnut/user-status';
import { threadCountLabel, threadLine } from '@open-walnut/thread-view';
import { isBoolean, usePageViewOf } from '@/utils/view-memory';
import { shortAgo } from './OrgChannelList';
import { theVp, type NowLine, type VpCard } from './org-chart-model';
import type { ChannelRow } from './org-channels-model';

/** A clickable div: Enter and Space press it too. */
export function pressable(onPress: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: onPress,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPress(); }
    },
  };
}

/** An element id from a row key ("project:event service" has a space, which breaks aria-controls). */
// One to one: every other UTF-16 unit, "_" included, becomes "_" and four hex digits.
export const domId = (prefix: string, key: string): string => `${prefix}-${key.replace(/[^A-Za-z0-9-]/g, (ch) => `_${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)}`;

/** Whether a card or row is open, kept per key on the Org page's view. */
export function useChartOpen(key: string): [boolean, () => void] {
  const [open, setOpen] = usePageViewOf('org', 'chart.open', key, false, isBoolean);
  return [open, () => setOpen((v) => !v)];
}

/** The one sign a closed card keeps: what its red on the Org list counts, as a dot. */
export function cardSign(row: ChannelRow, needsYou: number): string | null {
  if (row.threadsBadge !== undefined) return row.threadsBadge > 0 ? threadCountLabel(row.threadsBadge) : null;
  return needsYou > 0 ? stateCountLabel('needs', needsYou) : null;
}

function Dot({ sign, testId }: { sign: string | null; testId: string }) {
  return sign ? <span className="oc-dot" data-testid={testId} title={sign} aria-label={sign} role="img" /> : null;
}

/** "8 threads · 2 Needs you: Approve the push": the node's own Threads, when it keeps them. */
function threadsText(row: ChannelRow): string | null {
  const t = row.threads;
  if (row.threadsBadge === undefined) return null;
  const shown = t?.shown ?? row.threadsBadge;
  const head = [threadCountLabel(shown), t?.needs ? stateCountLabel('needs', t.needs) : ''].filter(Boolean).join(' · ');
  return t?.title && shown ? `${head}: ${t.title}` : head;
}

/** The card's news says what its threads line already says (a node's news leads with its threads). */
function newsIsThreads(news: string, row: ChannelRow): boolean {
  if (!row.threads?.shown) return false;
  const line = threadLine(row.threads);
  return news === line || news.endsWith(` · ${line}`);
}

/** "Tasks that need you: Garden 3 · Seeds 1": what its tasks ask, by project. The node's own
 *  threads are their own line, so a VP with threads never hides its tasks' asks. */
function taskAsks(c: VpCard): string | null {
  const parts = c.projects.filter((p) => p.row.alerts.length > 0).map((p) => `${p.name} ${p.row.alerts.length}`);
  return parts.length ? `Tasks that need you: ${parts.join(' · ')}` : null;
}

interface CeoProps {
  main: ChannelRow;
  /** "5 VPs · 5 Working". */
  line: string;
  onOpenChat: () => void;
  /** Its ⋯ menu. */
  more: ReactNode;
}

export function OrgChartCeo({ main, line, onOpenChat, more }: CeoProps) {
  const [open, toggle] = useChartOpen(`vp:${main.key}`);
  const sign = cardSign(main, main.needs);
  return (
    <div className={`oc-card oc-ceo${open ? ' is-open' : ''}`} data-testid="org-chart-ceo-card">
      <div className="oc-card-btn" data-testid="org-chart-ceo" aria-expanded={open} aria-controls="oc-detail-ceo" title={open ? 'Hide the CEO\'s detail' : 'Show what the CEO is doing'} {...pressable(toggle)}>
        <span className="oc-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="oc-card-title">CEO</span>
        <span className="oc-now" data-testid="org-chart-ceo-now">{line}</span>
        <Dot sign={sign} testId="org-chart-ceo-dot" />
      </div>
      {open && (
        <div className="oc-detail" id="oc-detail-ceo" data-testid="org-chart-ceo-detail">
          {threadsText(main) && <p className={`oc-detail-line is-clamped${main.threads?.needs ? ' is-alert' : ''}`} data-testid="org-chart-ceo-threads" title={threadsText(main)!}>{threadsText(main)}</p>}
          <div className="oc-detail-actions">
            <button type="button" className="oc-detail-btn" data-testid="org-chart-ceo-open" onClick={onOpenChat}>Open chat</button>
            {more}
          </div>
        </div>
      )}
    </div>
  );
}

interface VpProps {
  card: VpCard;
  now: number;
  /** The li's own class words (drag and drop states) and its drop zone. */
  className: string;
  zone: Record<string, unknown>;
  /** A VP made only to put projects under has no project of its own to drag. */
  draggable: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onContextMenu: (from: HTMLElement, point: { x: number; y: number }) => void;
  onOpenChat: () => void;
  /** Its open tasks and what it is doing now, after its name. */
  line: NowLine;
  /** Its ⋯ menu, for a VP (the Inbox has none). */
  more: ReactNode;
  /** The project rows, and the drop hint. */
  children: ReactNode;
}

/** "23m · Renew the permit": when the news was written, and the task it is about. */
const metaLine = (newsAt: number, task: string | undefined, now: number) => [shortAgo(newsAt, now), task].filter(Boolean).join(' · ');

export function OrgChartVp({ card: c, now, line, className, zone, draggable, onDragStart, onDragEnd, onContextMenu, onOpenChat, more, children }: VpProps) {
  // Its own key is its home project's row key too: the card and that row open apart.
  const [open, toggle] = useChartOpen(`vp:${c.key}`);
  const sign = cardSign(c.row, c.needsYou);
  const detailId = domId('oc-detail', c.key);
  const threads = threadsText(c.row);
  const meta = metaLine(c.newsAt, c.newsTask, now);
  // The news, unless it only repeats the threads or the counts (then its time goes with it).
  const news = !!c.news && c.news !== c.line && !newsIsThreads(c.news, c.row);
  const asks = taskAsks(c);
  return (
    <li
      className={`${className}${open ? ' is-open' : ''}`}
      data-testid="org-chart-vp"
      data-key={c.key}
      data-project={c.project}
      {...zone}
    >
      <div
        className="oc-vp-head"
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onContextMenu={(e) => { e.preventDefault(); onContextMenu(e.currentTarget, { x: e.clientX, y: e.clientY }); }}
        data-testid="org-chart-vp-handle"
      >
        {/* A div, not a button: WebKit and Firefox start no drag from inside a button. */}
        <div
          className="oc-card-btn"
          data-testid="org-chart-vp-toggle"
          aria-expanded={open}
          aria-controls={detailId}
          title={open ? `Hide the detail of ${theVp(c.name)}` : `Show what ${theVp(c.name)} is doing`}
          {...pressable(toggle)}
        >
          <span className="oc-chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="oc-card-main">
            <span className="oc-card-headline">
              <span className="oc-card-title" data-testid="org-chart-vp-name">{c.name}</span>
              <span className="oc-now" data-testid="org-chart-vp-now">{line.open} open</span>
            </span>
            {/* What it is doing now: its newest task at work, one line the card's width. */}
            {line.doing && <span className="oc-doing" data-testid="org-chart-vp-doing" title={line.words ? `${line.doing}: ${line.words}` : line.doing}>{line.doing}</span>}
          </span>
          <Dot sign={sign} testId="org-chart-vp-dot" />
        </div>
      </div>
      {open && (
        <div className="oc-detail" id={detailId} data-testid="org-chart-vp-detail">
          {threads && <p className={`oc-detail-line is-clamped${c.row.threads?.needs ? ' is-alert' : ''}`} data-testid="org-chart-vp-threads" title={threads}>{threads}</p>}
          {asks && <p className="oc-detail-line is-alert" data-testid="org-chart-vp-needs">{asks}</p>}
          {news && <p className={`oc-card-news${c.row.state === 'alert' ? ' is-alert' : ''}`} data-testid="org-chart-vp-news" title={c.newsTask ? `${c.newsTask}: ${c.news}` : c.news}>{c.news}</p>}
          {news && meta && <p className="oc-detail-line is-muted" data-testid="org-chart-vp-meta">{meta}</p>}
          {c.projects.length > 0
            ? <p className="oc-detail-line is-muted" data-testid="org-chart-vp-line">{c.line}</p>
            : <p className="oc-detail-line is-muted" data-testid="org-chart-vp-empty">{c.line}</p>}
          <div className="oc-detail-actions">
            <button type="button" className="oc-detail-btn" data-testid="org-chart-vp-open" onClick={onOpenChat}>Open chat</button>
            {more}
          </div>
        </div>
      )}
      {children}
    </li>
  );
}
