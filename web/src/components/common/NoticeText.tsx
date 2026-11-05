/**
 * A notice's words in the corner (toasts, permission prompts, board toasts): a `backticked`
 * command reads as code with its own Copy button, and a notice cut to its few lines says so
 * with a Details button that opens the whole text. 2026-11-05: a daemon error showed one
 * ellipsized line with the command it named cut off, and no way to read or copy the rest.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ICON_CHECK, ICON_COPY } from './Icons';
import { copyTextRobust } from '@/utils/clipboard';
import { log } from '@/utils/log';

export type NoticePart = { text: string } | { command: string };

/** Splits `a `cmd` b` into words and commands; an unpaired backtick stays a word. */
export function noticeParts(text: string): NoticePart[] {
  const parts: NoticePart[] = [];
  const re = /`([^`\n]+)`/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) parts.push({ text: text.slice(at, m.index) });
    parts.push({ command: m[1] });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

const COPIED_MS = 1500;

/**
 * One command, as code, with a Copy button that never opens or dismisses the notice under it.
 * It breaks only between its words (`--yes` never splits at its hyphens); a word longer than the
 * line still wraps inside itself. `copy: false` when the notice offers its own "Copy command".
 */
export function NoticeCommand({ command, copy = true }: { command: string; copy?: boolean }) {
  const words = command.split(/( +)/);
  return (
    <span className="notice-cmd">
      <code className="notice-cmd-code">{words.map((w, i) => (/^ +$/.test(w) ? w : <span key={i} className="notice-cmd-word">{w}</span>))}</code>
      {copy && <CopyCommandButton command={command} />}
    </span>
  );
}

/**
 * A title the server cut to its head ("…") and the record's detail that leads with the whole
 * line (log-error-bridge.ts withWholeLine): the whole line is the title, the rest stays detail.
 */
export function wholeTitle(title: string, detail: string | undefined): { title: string; detail: string } {
  const rest = detail ?? '';
  if (!title.endsWith('…') || !rest) return { title, detail: rest };
  const nl = rest.indexOf('\n');
  const first = nl < 0 ? rest : rest.slice(0, nl);
  const head = title.slice(0, -1).trimEnd();
  if (!head || !first.startsWith(head) || first.length <= head.length) return { title, detail: rest };
  return { title: first, detail: nl < 0 ? '' : rest.slice(nl + 1) };
}

/** The commands a notice names, in order, each once. */
export function noticeCommands(...texts: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const t of texts) for (const p of noticeParts(t ?? '')) if ('command' in p && !out.includes(p.command)) out.push(p.command);
  return out;
}

/** Copy for a command; it says Copied for a moment. `label` shows words beside the icon. */
export function CopyCommandButton({ command, label = false }: { command: string; label?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={label ? 'notice-cmd-copy notice-cmd-copy--label' : 'notice-cmd-copy'}
      data-testid={label ? 'notice-copy-command' : 'notice-cmd-copy'}
      aria-label={copied ? 'Copied' : `Copy ${command}`}
      title={copied ? 'Copied' : 'Copy command'}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        void copyTextRobust(command).then((r) => {
          if (r === 'failed') { log.warn('notifications', 'notice command copy failed', { length: command.length }); return; }
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), COPIED_MS);
        });
      }}
    >{copied ? ICON_CHECK : ICON_COPY}{label && <span className="notice-cmd-copy-words" data-other={copied ? 'Copy command' : 'Copied'}>{copied ? 'Copied' : 'Copy command'}</span>}</button>
  );
}

/** A notice's words with each command made copyable (`copy: false`: as code only). */
export function NoticeWords({ text, copy = true }: { text: string; copy?: boolean }) {
  return (
    <>
      {noticeParts(text).map((p, i) => ('command' in p
        ? <NoticeCommand key={i} command={p.command} copy={copy} />
        : <span key={i}>{p.text}</span>))}
    </>
  );
}

/** A raw log line `[subsystem] {json}` with its JSON laid out one field a line; anything else as it is. */
export function prettyDetail(detail: string): string {
  return detail.split('\n').map((line) => {
    const m = /^(\[[^\]]+\])\s*(\{.*\})\s*$/.exec(line);
    if (!m) return line;
    try { return `${m[1]}\n${JSON.stringify(JSON.parse(m[2]), null, 2)}`; } catch { return line; }
  }).join('\n');
}

/**
 * Whether any of these elements shows less than its words (a line clamp or an ellipsis cut
 * it). Measured after layout and again on every resize, so a narrower window that starts to
 * cut a title brings its Details button.
 */
export function useCutOff(refs: ReadonlyArray<RefObject<HTMLElement | null>>, key: unknown): boolean {
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const els = refs.map((r) => r.current).filter((e): e is HTMLElement => !!e);
    const measure = () => setCut(els.some((el) => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    for (const el of els) ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return cut;
}

/**
 * "Details" / "Less": opens the notice's whole text in place. `log`: nothing of its words is cut,
 * only the raw log line is behind it, so it says "Show log" / "Hide log".
 */
export function NoticeDetailsToggle({ open, onToggle, log = false }: { open: boolean; onToggle: () => void; log?: boolean }) {
  return (
    <button
      type="button"
      className="notice-details-toggle"
      data-testid="notice-details"
      aria-expanded={open}
      // The other label holds its width (CSS ::after), so the Copy beside it never moves.
      data-other={log ? (open ? 'Show log' : 'Hide log') : (open ? 'Details' : 'Less')}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
    >{log ? (open ? 'Hide log' : 'Show log') : (open ? 'Less' : 'Details')}</button>
  );
}
