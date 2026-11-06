/**
 * Every notice in the corner lets the person read its whole message (2026-11-05, the user on a
 * Mac app toast: "ui broken"; a daemon error read as one ellipsized line, the command it named
 * cut off, its x pushed outside the toast, and nothing opened the rest).
 *
 * The kinds are read from the source: every CORNER_ORDER key, every <CornerSlot> and every
 * appendToCornerStack() call. Each kind is listed below with how its whole message shows, and
 * that way is checked. A NEW kind fails here until it is listed with its way.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { noticeParts, prettyDetail, wholeTitle } from '../../web/src/components/common/NoticeText';
import { withWholeLine } from '../../src/core/notifications/log-error-bridge';
import { humanizeErrorNotification } from '../../src/core/notifications/humanize';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const sources = () =>
  execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'web/src/**/*.tsx', 'web/src/**/*.ts'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean).filter((f) => fs.existsSync(path.join(ROOT, f)));
const CSS = () => `${read('web/src/styles/globals.css')}\n${read('web/src/styles/corner-stack.css')}`;
/** The declarations of one exact selector's rules (every rule written for it). */
const rulesOf = (css: string, selector: string) => {
  const out: string[] = [];
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\n)\\s*${esc}\\s*\\{([^}]*)\\}`, 'g');
  for (let m = re.exec(css); m; m = re.exec(css)) out.push(m[2]);
  return out.join('\n');
};

/** Each kind and how its whole message shows. */
const KINDS: Record<string, { file: string; how: string; check: (src: string, css: string) => void }> = {
  toasts: {
    file: 'web/src/components/common/NotificationToaster.tsx',
    how: 'title two lines, body three, Details opens the rest and the record\'s detail; commands copyable',
    check: (src, css) => {
      expect(src).toMatch(/className="notification-toast-title"><NoticeWords text=\{whole\.title\} copy=\{!oneCopy\} \/>/);
      expect(src).toMatch(/className="notification-toast-body"><NoticeWords text=\{toast\.body\} copy=\{!oneCopy\} \/>/);
      // One command: one "Copy command" that stays whether the words are cut or open.
      expect(src).toContain('{oneCopy && <CopyCommandButton command={commands[0]} label />}');
      expect(src).toContain('useCutOff([titleRef, bodyRef]');
      expect(src).toMatch(/<NoticeDetailsToggle open=\{open\}/);
      // A permission prompt's command: two lines, Details, Copy.
      expect(src).toContain('<PermCommand command={detail.command}');
      expect(src).not.toMatch(/<code className="nfc-perm-cmd">\{detail\./);
      const title = rulesOf(css, '.notification-toast-title');
      expect(title).not.toMatch(/white-space:\s*nowrap/);
      expect(title).toMatch(/-webkit-line-clamp:\s*2/);
      expect(title).toMatch(/min-width:\s*0/);
      expect(rulesOf(css, '.notification-toast-header')).toMatch(/min-width:\s*0/);
      expect(rulesOf(css, '.nfc-perm-context')).not.toMatch(/white-space:\s*nowrap/);
      expect(css).toMatch(/\.notification-toast\.is-open :is\(\.notification-toast-title, \.notification-toast-body\) \{[^}]*display: block/);
      // The compact and beside-an-approval form: its header never grows past the toast.
      expect(css).toMatch(/\.notification-toast:not\(\.nfc-perm-toast\) \.notification-toast-header \{ flex: 0 0 100%; min-width: 0; \}/);
      // A folded toast the notification center does not keep (an Undo) is unfolded in place.
      expect(src).toContain('const foldsEphemeral = folded.some((t) => !t.persistent);');
      expect(src).toMatch(/const openCenter = foldsEphemeral\s*\? \(\) => setUnfolded\(true\)/);
      // The phone hides the body until Details opens it.
      expect(css).toContain('.notification-toast:not(.nfc-perm-toast):not(.is-open) :is(.notification-toast-body');
    },
  },
  board: {
    file: 'web/src/components/board/kanban/KanbanToasts.tsx',
    how: 'three lines, Details opens the rest and holds the clocks',
    check: (src, css) => {
      expect(src).toContain('<KanbanToastText text={t.text}');
      expect(src).toContain('useCutOff([ref], text)');
      expect(src).toContain('if (reading.current.size > 0) return;');
      expect(css).toMatch(/\.corner-stack \.kanban-toast-text\.is-open \{ display: block/);
    },
  },
  flash: {
    file: 'web/src/popout/openPopout.ts',
    how: 'fixed short sentences of Walnut\'s own, which wrap: nothing to cut',
    check: (src) => {
      const calls = [...src.matchAll(/flashNotice\(([^)]*)\)/g)].map((m) => m[1]).filter((a) => !a.startsWith('text'));
      for (const arg of calls) expect(arg).toMatch(/^'[^']{1,80}'$/);
      expect(src).not.toMatch(/popout-flash-notice[\s\S]{0,400}nowrap/);
    },
  },
  approvals: {
    file: 'web/src/components/approvals/ApprovalPrompts.tsx',
    how: 'the card is a summary; a click opens the request\'s dialog with its whole words',
    check: (src) => {
      // The title opens the whole request; the asking task's name is the way to the task (2026-11-06).
      expect(src).toMatch(/approval-what-open" title="Open the request" data-testid="approval-what" onClick=\{onOpen\}/);
      expect(src).toMatch(/data-testid="approval-task-link"/);
      expect(src).toContain('data-testid="approval-dialog"');
    },
  },
};

describe('every corner notice shows its whole message', () => {
  it('lists every kind the corner has', () => {
    const corner = read('web/src/components/common/corner-stack.tsx');
    const block = corner.slice(corner.indexOf('export const CORNER_ORDER = {'), corner.indexOf('} as const', corner.indexOf('export const CORNER_ORDER = {')));
    const keys = [...block.matchAll(/^\s+(\w+):\s*\d+/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(keys)).toEqual(new Set(Object.keys(KINDS)));
    // Every place that renders into the corner, by the kind it names.
    const used = new Map<string, string>();
    for (const f of sources()) {
      if (f.endsWith('corner-stack.tsx')) continue;
      const src = read(f);
      for (const m of src.matchAll(/(?:<CornerSlot order=\{CORNER_ORDER\.|appendToCornerStack\([^,]+,\s*CORNER_ORDER\.)(\w+)/g)) used.set(m[1], f);
    }
    for (const [kind, file] of used) {
      expect(KINDS[kind], `${kind} (${file}) renders into the corner: list how its whole message shows`).toBeDefined();
      expect(file).toBe(KINDS[kind].file);
    }
  });

  for (const [kind, k] of Object.entries(KINDS)) {
    it(`${kind}: ${k.how}`, () => k.check(read(k.file), CSS()));
  }

  it('reads a backticked command as one, and leaves an unpaired backtick as words', () => {
    expect(noticeParts('use `walnut daemon install --yes` on that host.')).toEqual([
      { text: 'use ' }, { command: 'walnut daemon install --yes' }, { text: ' on that host.' },
    ]);
    expect(noticeParts('a ` b')).toEqual([{ text: 'a ` b' }]);
    expect(noticeParts('`x``y`')).toEqual([{ command: 'x' }, { command: 'y' }]);
  });

  it('shows a cut title whole when the detail leads with its line, and keeps the rest as detail', () => {
    const line = 'A long line that the server cut, ending in `walnut x --y` on that host.';
    const cutTitle = `${line.slice(0, 40)}…`;
    expect(wholeTitle(cutTitle, `${line}\n[session] {}`)).toEqual({ title: line, detail: '[session] {}' });
    expect(wholeTitle(cutTitle, line)).toEqual({ title: line, detail: '' });
    // A detail that is not this title's line, or a title that was not cut, is left alone.
    expect(wholeTitle(cutTitle, '[session] {}')).toEqual({ title: cutTitle, detail: '[session] {}' });
    expect(wholeTitle('Short title', `Short title and more\n[x]`)).toEqual({ title: 'Short title', detail: 'Short title and more\n[x]' });
  });

  it('words the deferred daemon update plainly, with its command to copy', () => {
    const h = humanizeErrorNotification({
      title: 'DaemonConnection: managed daemon update was deferred; use `walnut daemon install --yes --executable <daemon binary>` on that host.',
      subsystem: 'session',
      meta: { host: 'devbox', expected: '2.3.0', remoteVersion: '2.2.9' },
    });
    expect(h.title).toBe('The daemon on devbox needs an update');
    expect(h.message).toBe("Set <daemon binary> to the new daemon file's path, then run on devbox: `walnut daemon install --yes --executable <daemon binary>`. It runs 2.2.9, Walnut 2.3.0.");
    // This machine's own daemon says it in other words; the same card.
    const local = humanizeErrorNotification({ title: 'Managed local daemon version differs; automatic update was deferred; use walnut daemon install --yes --executable <daemon binary>', subsystem: 'session', meta: {} });
    expect(local.title).toBe("This machine's daemon needs an update");
    expect(local.message).toContain('then run on this machine: `walnut daemon install --yes --executable <daemon binary>`');
    expect(noticeParts(h.message).filter((p) => 'command' in p)).toEqual([{ command: 'walnut daemon install --yes --executable <daemon binary>' }]);
  });

  it('lays a raw log line\'s JSON out one field a line', () => {
    expect(prettyDetail('[session] {"host":"devbox","n":1}')).toBe('[session]\n{\n  "host": "devbox",\n  "n": 1\n}');
    expect(prettyDetail('plain words')).toBe('plain words');
    expect(prettyDetail('[x] {not json}')).toBe('[x] {not json}');
  });

  it('keeps the whole log line in Details when the title shows only its head', () => {
    const line = `DaemonConnection: managed daemon update was deferred; use \`walnut daemon install --yes --executable <daemon binary>\` on that host.`;
    const title = `${line.slice(0, 119)}…`;
    expect(withWholeLine(title, line, '[session] {"host":"devbox"}')).toBe(`${line}\n[session] {"host":"devbox"}`);
    expect(withWholeLine(title, line, undefined)).toBe(line);
    expect(withWholeLine('Short title', 'Short title', '[web] {}')).toBe('[web] {}');
  });
});
