/**
 * What a session holds live (the servers it started, the person's browser tabs it uses) shows only
 * as a small pill in the session header, with its details and actions (Open, Stop, the Browser view)
 * in the pill's popover; never as a card in the chat timeline or above the composer. 2026-11-09, the
 * user, of a "Server this turn started" card at the bottom of the chat: "not show bottom,only show
 * the top one there", then "same for brwoser, we only show as a small pill tehere people can click
 * and see detail".
 *
 * The class is enumerated from the source: every file in web/src that reads a live resource (the
 * hooks, the API module, the list and view components, the routes they call) must be listed here
 * with why it is not the chat. A new card in the chat has to read one of them, so it fails here
 * until it is drawn as a header pill instead. SessionPanel itself may draw them only inside
 * headerPills or the phone's kebab slot, and the chat's own files may not import them at all.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WEB = path.resolve(__dirname, '../../web/src');
const rel = (f: string) => path.relative(WEB, f).split(path.sep).join('/');

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : files(p);
    return /\.(tsx?|css)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** What reads or draws a live resource of a session. A new kind of live resource adds its own here. */
const LIVE_SOURCES: Array<[string, RegExp]> = [
  ['servers hook', /\buseSessionServers\b/],
  ['servers API', /from '@\/api\/session-servers'/],
  ['servers list', /\bSessionServerList\b/],
  ['servers route', /\/api\/sessions\/[^'"`]*\/servers\b/],
  ['browser hook', /\buseBrowserView\b/],
  ['browser view', /\bSessionBrowserCard\b/],
  ['browser replay', /\bSessionBrowserReplay\b/],
  ['browser route', /\/api\/v1\/browser\/view/],
  // What draws one counts as reading it, so a wrapper of a pill or a view mounted in the chat
  // (a "LiveResourceCard" rendering SessionBrowserChip) is a new reader too.
  ['servers pill', /\bSessionServersChip\b/],
  ['browser pill', /\bSessionBrowserChip\b/],
  ['web view', /\bSessionWebView\b/],
];

/** Every file allowed to read one, and why it is not a card in the chat. */
const ALLOWED: Record<string, string> = {
  'api/session-servers.ts': 'the API module itself',
  'hooks/useSessionServers.ts': 'the servers hook itself',
  'components/sessions/useBrowserView.ts': 'the browser hook itself',
  'components/sessions/SessionServerList.tsx': 'the servers list, drawn in the pill popover and the Web view',
  'components/sessions/SessionServersChip.tsx': 'the servers header pill and its popover',
  'components/sessions/SessionBrowserChip.tsx': 'the browser header pill and its popover',
  'components/sessions/SessionBrowserCard.tsx': 'the Browser view, drawn only in the browser pill popover',
  'components/sessions/SessionBrowserReplay.tsx': 'the Browser replay, drawn only inside the Browser view (the browser pill popover)',
  'components/sessions/SessionWebView.tsx': 'the Web split view the person opens beside the chat, not in it',
  'components/sessions/SessionPanel.tsx': 'mounts the pills in headerPills and the phone kebab slot (checked below)',
  'components/sessions/SessionKebabSection.tsx': 'the session menu row that opens the Web view',
  'components/sessions/SessionMenuOpen.tsx': 'the session menu Open row',
  'components/sessions/PhoneSessionHeaderRows.tsx': 'the phone session menu rows',
  'components/sessions/SessionMetaFacts.tsx': 'the session details facts in the menu',
};

const strip = (src: string) => src
  // Comments name these freely; only code counts.
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  // A type alone reads nothing.
  .replace(/^import type [^;]+;$/gm, '');

describe('live resources are header pills only', () => {
  it('every file that reads a live resource is listed, with why it is not the chat', () => {
    // Code only: a stylesheet reads nothing (the old card's class is checked below).
    const readers = files(WEB).filter((f) => /\.tsx?$/.test(f)).filter((f) => {
      const src = strip(fs.readFileSync(f, 'utf8'));
      return LIVE_SOURCES.some(([, re]) => re.test(src));
    }).map(rel).sort();
    const unlisted = readers.filter((f) => !(f in ALLOWED));
    expect(unlisted, 'a new reader of a live resource: draw it as a pill in SessionPanel headerPills with its details in a popover, never a card in the chat; then list it here').toEqual([]);
    // A listed file that no longer reads one is dropped from the list.
    const stale = Object.keys(ALLOWED).filter((f) => !readers.includes(f));
    expect(stale, 'listed but reads no live resource any more').toEqual([]);
  });

  it('a wrapper that only draws a pill or the view counts as a reader', () => {
    // 2026-11-09 review: a LiveResourceCard rendering SessionBrowserChip, mounted in the chat,
    // passed the first version of this guard.
    for (const src of ['<SessionBrowserChip taskId={id} view={v} />', '<SessionServersChip servers={s} />', '<SessionBrowserCard taskId={id} />', '<SessionServerList servers={s} />']) {
      expect(LIVE_SOURCES.some(([, re]) => re.test(strip(src))), src).toBe(true);
    }
  });

  it('the chat timeline files read no live resource', () => {
    // The chat's files by name, and every module the timeline imports (whatever it is called).
    const dir = path.join(WEB, 'components/sessions');
    const history = fs.readFileSync(path.join(dir, 'SessionChatHistory.tsx'), 'utf8');
    const imported = [...history.matchAll(/from '\.\/([^']+)'/g)]
      .map((m) => ['.tsx', '.ts'].map((x) => path.join(dir, m[1]! + x)).find((f) => fs.existsSync(f)))
      .filter((f): f is string => !!f);
    const chat = [...new Set([...files(dir).filter((f) => /SessionChat|ChatHistory|Composer|Timeline|TurnCard/.test(path.basename(f))), ...imported])];
    expect(chat.length).toBeGreaterThan(0);
    for (const f of chat) {
      const src = strip(fs.readFileSync(f, 'utf8'));
      const hits = LIVE_SOURCES.filter(([, re]) => re.test(src)).map(([n]) => n);
      expect(hits, `${rel(f)} reads a live resource`).toEqual([]);
      expect(src, `${rel(f)} draws a live resource pill`).not.toMatch(/<Session(Servers|Browser)Chip\b/);
    }
    // The old in-chat cards stay gone.
    expect(fs.existsSync(path.join(WEB, 'components/sessions/SessionServersTurnCard.tsx'))).toBe(false);
    const css = files(path.join(WEB, 'styles')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    expect(css).not.toMatch(/session-servers-turn-card/);
  });

  it('SessionPanel draws them only in headerPills and the phone kebab slot', () => {
    const src = strip(fs.readFileSync(path.join(WEB, 'components/sessions/SessionPanel.tsx'), 'utf8'));
    const start = src.indexOf('const headerPills = (');
    const end = src.indexOf('\n  );\n', start);
    expect(start).toBeGreaterThan(0);
    const pills = src.slice(start, end);
    expect(pills).toMatch(/<SessionServersChip\b/);
    expect(pills).toMatch(/<SessionBrowserChip\b/);
    // Outside headerPills: only the phone's compact pills, portalled into its kebab slot.
    const rest = (src.slice(0, start) + src.slice(end))
      .replace(/createPortal\(\s*<Session(Servers|Browser)Chip\b(?:(?!\/>)[\s\S])*\bcompact \/>,\s*kebabSlot/g, 'createPortal(PHONE_PILL, kebabSlot');
    expect(rest).not.toMatch(/<Session(Servers|Browser)Chip\b/);
    // The lists and the Browser view are the pills' popovers' (and the Web view's), never the panel body's.
    expect(rest).not.toMatch(/<(SessionServerList|SessionBrowserCard)\b/);
  });
});
