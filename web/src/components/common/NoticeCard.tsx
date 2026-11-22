/**
 * The one card every notice is drawn as (2026-11-20, the user, of the quick bar's "Delivered" card:
 * "能不能把这个 notification 变成一个透明的，然后把所有的 notification 都设计成这种" and "我们能不能有一个
 * generic 的 notification system ... 整个 system 就那么一个 notification system"): a rounded card of
 * frosted glass with the same hairline on all four sides (never a coloured bar down one side), an
 * avatar, a bold title, a status as a dot and a word, and a preview of two lines. A notice's own
 * content (a form, its buttons, the whole reply) goes below as children.
 *
 * Where it shows is the corner stack's (corner-stack.tsx: one stack at the bottom left), never the
 * card's: a notice renders a NoticeCard inside a <CornerSlot>. tests/web/notice-card-guard.test.ts
 * fails on a notice in the stack drawn some other way, and on a toast component of its own.
 */
import type { CSSProperties, HTMLAttributes, MouseEventHandler, ReactNode, Ref } from 'react';
import { PersonAvatar } from '@/components/quickbar/PersonAvatar';
import type { Notification, NotificationSeverity } from '@/contexts/notifications/types';
import { avatarName, noticeTone } from '@/contexts/notifications/notice-face';
import { ICON_CHECK, ICON_CLOSE, ICON_INFO, ICON_WARNING } from './Icons';
import '@/styles/notice-card.css';

/** What a status says by its colour: live (on its way), ok (done), warn, error, ask (waits on you), muted. */
export type NoticeTone = 'live' | 'ok' | 'warn' | 'error' | 'ask' | 'muted';

/** The status of a notice: a small dot and its word, coloured by tone (the "● Delivered" of the quick bar). */
export function NoticeStatus({ tone, children, className, title }: { tone: NoticeTone; children?: ReactNode; className?: string; title?: string }) {
  return (
    <span className={`wn-notice-status${className ? ` ${className}` : ''}`} data-tone={tone} title={title}>
      <span className="wn-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

/** A person or task (letters in their own steady colour), or a glyph on a tile of the tone's colour. */
export type NoticeAvatarSpec =
  | { person: { id: string; title: string; kind: 'ceo' | 'vp' | 'task' } }
  | { glyph: ReactNode; tone: NoticeTone };

export function NoticeAvatar({ spec, size = 22 }: { spec: NoticeAvatarSpec; size?: number }) {
  if ('person' in spec) return <PersonAvatar person={spec.person} size={size} />;
  return (
    <span className="wn-notice-avatar" data-tone={spec.tone} style={{ width: size, height: size }} aria-hidden="true">
      {spec.glyph}
    </span>
  );
}

/** The glyph on a notice's tile when no task or session names it. */
export const SEVERITY_GLYPH: Record<NotificationSeverity, ReactNode> = {
  info: ICON_INFO,
  success: ICON_CHECK,
  warning: ICON_WARNING,
  error: ICON_CLOSE,
};

/**
 * A notification's avatar, the same on its toast and on its row in the notification center: the
 * task or session it is about (its letters in their steady colour), else its severity's glyph.
 * The letters come from the name a person gave it, never from a fork's machine prefix or an id.
 */
export function noticeAvatarOf(
  n: Pick<Notification, 'kind' | 'severity' | 'resolved' | 'sessionTitle' | 'sessionId' | 'taskId'>,
  name: string | undefined = n.sessionTitle,
): NoticeAvatarSpec {
  const id = n.taskId ?? n.sessionId;
  const title = avatarName(name);
  if (id && title) return { person: { id, title, kind: 'task' } };
  return { glyph: n.kind === 'permission' ? SEVERITY_GLYPH.warning : SEVERITY_GLYPH[n.severity] ?? SEVERITY_GLYPH.info, tone: noticeTone(n) };
}

export interface NoticeCardProps {
  avatar?: NoticeAvatarSpec;
  /** The bold title: who it is from, or what it is about. */
  who?: ReactNode;
  status?: { tone: NoticeTone; text?: ReactNode; title?: string };
  /** The title wraps in full and is never cut (`.wn-title`: a list's card, where the title is what
   *  tells one row from the next; standard.md "Text that does not fit"), instead of one line. */
  wrapTitle?: boolean;
  /** One quiet line under the title: the status, when, where it came from (a list's card puts its
   *  time here so the title keeps the width). */
  meta?: ReactNode;
  /** The preview under the title, two lines at most (its own element keeps any refs and classes). */
  line?: ReactNode;
  /** Controls at the end of the title row ("N more ›", –). */
  end?: ReactNode;
  /** The card's ×, at the end of the title row: every notice in the stack can be closed (2026-11-22,
   *  the user, of a "Not sent" receipt that stayed: "why there is no x so that i cna close"). */
  onClose?: () => void;
  /** What the × says to a screen reader (default "Dismiss"). */
  closeLabel?: string;
  /** A click on the head (the avatar, title, status and preview): open what it is about. */
  onOpen?: () => void;
  openTitle?: string;
  expanded?: boolean;
  /** The notice's own content under the head: its whole text, a form, its buttons. */
  children?: ReactNode;
  /** Children start under the words, past the avatar (the default), or at the card's left edge. */
  bodyFlush?: boolean;
  className?: string;
  role?: string;
  style?: CSSProperties;
  testId?: string;
  data?: Record<string, string | undefined>;
  cardRef?: Ref<HTMLDivElement>;
  /** On the preview's own element (a notice measures whether its words are cut). */
  lineRef?: Ref<HTMLSpanElement>;
  onClick?: MouseEventHandler<HTMLDivElement>;
  onMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: MouseEventHandler<HTMLDivElement>;
  onMouseMove?: MouseEventHandler<HTMLDivElement>;
  title?: string;
  ariaLabel?: string;
  ariaLive?: 'polite' | 'assertive';
  /** Any other listeners for the card's element (pointer, focus and key capture, a swipe). */
  handlers?: Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'children' | 'style' | 'role' | 'title'>;
  /** Solid, not glass: for a card drawn inside a panel, where WebKit's blur cannot reach the page
   *  behind it (it blurs only up to the nearest backdrop root) and the words under it would read through. */
  solid?: boolean;
  /** Extra class names on the parts (a notice's own names, which its tests read). */
  parts?: { open?: string; who?: string; status?: string; line?: string; body?: string };
}

const cx = (...names: Array<string | false | undefined>) => names.filter(Boolean).join(' ');

export function NoticeCard(p: NoticeCardProps) {
  const dataAttrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.data ?? {})) if (v !== undefined) dataAttrs[`data-${k}`] = v;
  const words = (
    <>
      {p.avatar && <NoticeAvatar spec={p.avatar} />}
      <span className="wn-notice-text">
        {(p.who !== undefined || p.status) && (
          <span className="wn-notice-top">
            {p.who !== undefined && <span className={cx('wn-notice-who', p.wrapTitle && 'is-wrap wn-title', p.parts?.who)}>{p.who}</span>}
            {p.status && <NoticeStatus tone={p.status.tone} title={p.status.title} className={p.parts?.status}>{p.status.text}</NoticeStatus>}
          </span>
        )}
        {p.meta !== undefined && p.meta !== null && p.meta !== false && <span className="wn-notice-meta">{p.meta}</span>}
        {p.line !== undefined && p.line !== null && p.line !== false && <span ref={p.lineRef} className={cx('wn-notice-line', p.parts?.line)}>{p.line}</span>}
      </span>
    </>
  );
  const hasHead = !!(p.avatar || p.who !== undefined || p.status || p.meta || p.line || p.end || p.onClose);
  const close = p.onClose && (
    <button type="button" className="btn btn-ghost btn-icon btn-sm wn-notice-close" aria-label={p.closeLabel ?? 'Dismiss'} title={p.closeLabel ?? 'Dismiss'}
      onClick={(e) => { e.stopPropagation(); p.onClose!(); }}>
      &times;
    </button>
  );
  return (
    <div
      ref={p.cardRef}
      className={cx(p.solid ? 'wn-notice' : 'wn-notice wn-glass-frost', !hasHead && 'is-bare', p.className)}
      role={p.role}
      style={p.style}
      data-testid={p.testId}
      aria-live={p.ariaLive}
      aria-label={p.ariaLabel}
      title={p.title}
      onClick={p.onClick}
      onMouseEnter={p.onMouseEnter}
      onMouseLeave={p.onMouseLeave}
      onMouseMove={p.onMouseMove}
      {...p.handlers}
      {...dataAttrs}
    >
      {hasHead && (
        <div className="wn-notice-head">
          {p.onOpen ? (
            <button type="button" className={cx('wn-notice-open', p.parts?.open)} onClick={p.onOpen} title={p.openTitle} aria-expanded={p.expanded}>
              {words}
            </button>
          ) : (
            <span className={cx('wn-notice-open', p.parts?.open)}>{words}</span>
          )}
          {(p.end || close) && <span className="wn-notice-end">{p.end}{close}</span>}
        </div>
      )}
      {/* With a head, the notice's own content sits under its words; with none (a form that lays
          itself out, as an approval card does), it is the card's whole content. */}
      {hasHead ? (p.children !== undefined && p.children !== null && p.children !== false && (
        <div className={cx('wn-notice-body', p.parts?.body, (p.bodyFlush || !p.avatar) && 'is-flush')}>{p.children}</div>
      )) : p.children}
    </div>
  );
}

/** For code outside React (a pop-out's one-line flash): the same card as a DOM element. */
export function noticeCardElement(opts: { who: string; line?: string; tone: NoticeTone; status?: string }): HTMLDivElement {
  const card = document.createElement('div');
  card.className = 'wn-notice wn-glass-frost';
  card.setAttribute('role', 'status');
  const head = document.createElement('div');
  head.className = 'wn-notice-head';
  const open = document.createElement('span');
  open.className = 'wn-notice-open';
  const text = document.createElement('span');
  text.className = 'wn-notice-text';
  const top = document.createElement('span');
  top.className = 'wn-notice-top';
  const who = document.createElement('span');
  who.className = 'wn-notice-who';
  who.textContent = opts.who;
  top.appendChild(who);
  if (opts.status) {
    const status = document.createElement('span');
    status.className = 'wn-notice-status';
    status.dataset.tone = opts.tone;
    const dot = document.createElement('span');
    dot.className = 'wn-dot';
    status.append(dot, opts.status);
    top.appendChild(status);
  }
  text.appendChild(top);
  if (opts.line) {
    const line = document.createElement('span');
    line.className = 'wn-notice-line';
    line.textContent = opts.line;
    text.appendChild(line);
  }
  open.appendChild(text);
  head.appendChild(open);
  card.appendChild(head);
  return card;
}
