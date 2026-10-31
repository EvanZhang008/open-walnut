/**
 * Guard: what Home and Org show must survive a restart, so none of it may live only in
 * sessionStorage; and a passing overlay must never come back on its own after one.
 *
 * 2026-10-31, the user: "every time the Mac app restarts everything is gone ... these states
 * should be permanent, on disk". The Mac app's web view drops sessionStorage on every relaunch
 * and page-process recycle; Home's columns (with their locks), the focused task and the chat
 * slot's ask lived there. They are layout record fields now (web/src/utils/layout-record.ts),
 * mirrored to the server's ui-prefs.json.
 *
 * The class: a piece of view state kept in sessionStorage, or in a localStorage key the mirror
 * never sends to disk. This test enumerates every member from the source:
 *  1. every web/src file that touches sessionStorage is listed below with why its use is
 *     per-tab by design, and every key read or written there directly is a listed key;
 *  2. every localStorage key named in a Home or Org file is mirrored (syncable) or listed as
 *     deliberately device-local (it still survives a restart on that device).
 *  3. every passing overlay starts closed on a load (its open state is a literal `false`, read
 *     from no storage and no URL), and every path that brings the focused task back after a
 *     load focuses it without its full-screen detail (2026-10-31, the user: "every time walnut
 *     restarts it always shows some task in full screen").
 * A new file or key fails here until someone decides where it belongs. Home or Org layout that
 * must survive a restart belongs in LAYOUT_FIELDS.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { syncable } from '../../web/src/utils/ui-prefs-sync';

const ROOT = join(__dirname, '../..');
const WEB_SRC = join(ROOT, 'web/src');

/** Files that touch sessionStorage, and why that is per tab by design. */
const SESSION_FILES: Record<string, string> = {
  'api/test-run.ts': 'the ?walnut-test-run= marker is for the tab that was opened with it',
  'components/common/AppErrorBoundary.tsx': 'a debug switch that crashes this tab once',
  'components/common/UnpairedNotice.tsx': 'a sign-out notice for this tab only',
  'components/settings/sections/DevicesSection.tsx': 'which pairing way this visit picked',
  'components/settings/sections/cloud/OwnDeviceSignOut.tsx': 'sets the sign-out notice flag',
  'components/settings/SettingsSection.tsx': 'the settings hash target of this visit',
  'components/board/kanban/useKanbanLayout.ts': 'done rails opened for this visit (spec 3.2)',
  'components/chat/island-runtime.ts': 'blocks storage inside a sandboxed island, touches no key',
  'hooks/usePhoneRestore.ts': 'the scroll anchor of one reload; the strip itself is phoneColumns',
  'pages/MainPage.tsx': 'the todo list scroll offset, and the legacy single-session key it migrates',
  'utils/browser-logger.ts': 'a per-tab id for log lines',
  'utils/crash-recovery.ts': 'the crash log must reset with the tab; it clears the layout record too',
  'utils/crash-report.ts': 'reads storage to report a crash',
  'utils/layout-record.ts': 'adopts the pre-record sessionStorage keys once',
  'utils/scroll-debug.ts': 'a debug timer',
  'utils/stale-assets.ts': 'reload bookkeeping of one tab',
  'utils/thread-stack-persist.ts': 'the question stack inside one panel, per tab by spec C69; the panel is in the layout record',
  'utils/ui-prefs-sync.ts': 'the one-boot skip flag crash recovery sets',
};

/** sessionStorage keys read or written directly by name. */
const SESSION_KEYS: Record<string, string> = {
  'walnut-test-run': 'test-run marker',
  'open-walnut-debug-crash-once': 'debug crash switch',
  'walnut.signedOut': 'sign-out notice',
  'walnut:devices-open-way': 'pairing way of this visit',
  'walnut.phoneRestore': 'one reload anchor',
  'walnut-home-todo-scroll': 'todo list scroll of this tab',
  'open-walnut-home-session-panel': 'legacy single-session key, migrated and removed',
  'walnut-log-tab': 'per-tab log id',
  'open-walnut-crash-log': 'crash log',
  'open_walnut_scroll_debug_t0': 'debug timer',
  'open-walnut-skip-prefs-merge': 'one-boot skip flag',
};

/** Files that draw Home or Org. */
const HOME_ORG = (rel: string): boolean =>
  rel === 'pages/MainPage.tsx' || rel === 'pages/OrgPage.tsx' || rel === 'components/chat/AskWalnutSlot.tsx'
  || /^pages\/home-[^/]+\.ts$/.test(rel) || rel.startsWith('components/org/');

/** localStorage keys in Home/Org files that are deliberately this device's own (they survive a restart here). */
const DEVICE_LOCAL_KEYS: Record<string, string> = {
  'walnut.org.place': "the Org page's place; a phone's place is not the Mac's (org-place.ts)",
  'walnut.org.topView': 'Status or Brief above the chat, per device',
  'walnut.org.briefFolded': 'the Brief folded, per device',
  'walnut.org.briefSeen': 'when this device last read each Brief',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(WEB_SRC).map((p) => ({ rel: relative(WEB_SRC, p), src: readFileSync(p, 'utf8') }));
const allSrc = files.map((f) => f.src).join('\n');

/** Code only: drop line and block comments (rough, enough for identifiers). */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** The value of a call's first argument: a literal, or a const named in this file or exported anywhere. */
function resolveKey(arg: string, src: string): string | null {
  const lit = /^['"`]([^'"`$]+)['"`]$/.exec(arg.trim());
  if (lit) return lit[1];
  const id = arg.trim();
  if (!/^[A-Z][A-Z0-9_]*$/.test(id)) return null; // a parameter or an expression: not a fixed key
  const re = new RegExp(`const ${id}\\b[^=]*=\\s*['"\`]([^'"\`$]+)['"\`]`);
  return re.exec(src)?.[1] ?? re.exec(allSrc)?.[1] ?? `<unresolved ${id}>`;
}

function directKeys(src: string, store: 'sessionStorage' | 'localStorage'): string[] {
  const re = new RegExp(`\\b${store}\\??\\.(?:get|set|remove)Item\\(\\s*([^,)]+)`, 'g');
  const keys: string[] = [];
  for (const m of code(src).matchAll(re)) {
    const key = resolveKey(m[1], src);
    if (key !== null) keys.push(key);
  }
  return keys;
}

describe('Home and Org state is kept on disk, not only in sessionStorage', () => {
  it('every file that touches sessionStorage is listed with its reason', () => {
    const using = files.filter((f) => /\bsessionStorage\b/.test(code(f.src))).map((f) => f.rel).sort();
    const unlisted = using.filter((rel) => !(rel in SESSION_FILES));
    expect(unlisted, 'new sessionStorage use: Home/Org state that must survive a restart goes in LAYOUT_FIELDS (utils/layout-record.ts); per-tab state is listed here with why').toEqual([]);
    const stale = Object.keys(SESSION_FILES).filter((rel) => !using.includes(rel));
    expect(stale, 'listed files that no longer touch sessionStorage: remove them').toEqual([]);
  });

  it('every sessionStorage key used by name is a listed per-tab key', () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const key of directKeys(f.src, 'sessionStorage')) if (!(key in SESSION_KEYS)) bad.push(`${f.rel}: ${key}`);
    }
    expect(bad).toEqual([]);
  });

  it('none of the keys the layout record replaced is written to sessionStorage again', () => {
    const retired = ['open-walnut-home-session-columns', 'open-walnut-home-focused-task', 'open-walnut-home-suppress-detail', 'walnut:ask-slot:selected', 'walnut:ask-slot:agent'];
    for (const key of retired) expect(SESSION_KEYS[key], key).toBeUndefined();
  });

  it('every localStorage key a Home or Org file names goes to disk, or is listed as device-local', () => {
    const bad: string[] = [];
    let seen = 0;
    for (const f of files.filter((x) => HOME_ORG(x.rel))) {
      for (const key of directKeys(f.src, 'localStorage')) {
        seen++;
        if (!syncable(key) && !(key in DEVICE_LOCAL_KEYS)) bad.push(`${f.rel}: ${key}`);
      }
    }
    expect(seen, 'the scan found no keys: the matcher broke').toBeGreaterThan(5);
    expect(bad).toEqual([]);
  });

  it('the scan sees the files it guards', () => {
    expect(files.some((f) => f.rel === 'pages/MainPage.tsx')).toBe(true);
    expect(files.filter((f) => HOME_ORG(f.rel)).length).toBeGreaterThan(5);
  });
});

/** Overlays that must start closed on every load: file, and the state that opens it. */
const NEVER_RESTORED: ReadonlyArray<{ file: string; state: string; closed: string; what: string }> = [
  // The detail shows while a task is focused and not suppressed: the focus starts empty, and
  // a load brings it back only through restoreFocus (checked below), which suppresses it.
  { file: 'pages/MainPage.tsx', state: 'selectedTask', closed: 'null', what: 'the full-screen task detail' },
  { file: 'pages/MainPage.tsx', state: 'sessionSearchOpen', closed: 'false', what: 'the session finder' },
  { file: 'hooks/useFullscreen.tsx', state: 'isFullscreen', closed: 'false', what: 'a fullscreen panel' },
  { file: 'components/chat/AskWalnutSlot.tsx', state: 'drawerOpen', closed: 'false', what: "the chat slot's drawer" },
];

describe('a passing overlay never comes back on its own after a load', () => {
  const src = (rel: string): string => files.find((f) => f.rel === rel)?.src ?? '';

  it('each starts from a literal, never from storage or the URL', () => {
    for (const o of NEVER_RESTORED) {
      const decl = new RegExp(`const \\[${o.state}, set\\w+\\] = useState(?:<[^>]+>)?\\(([^)]*)\\)`).exec(src(o.file));
      expect(decl, `${o.file}: ${o.state} (${o.what}) not found`).not.toBeNull();
      expect(decl![1].trim(), `${o.what} must start closed`).toBe(o.closed);
    }
  });

  it('every path that brings the focused task back after a load uses restoreFocus (focus, no detail)', () => {
    const main = code(src('pages/MainPage.tsx'));
    // The URL's pending state (a load, Back/Forward).
    const pending = main.slice(main.indexOf('if (urlSync.pending)'), main.indexOf('urlSync.clearPending();'));
    expect(pending.length, 'the URL restore block moved: update this guard').toBeGreaterThan(50);
    // The address the page loaded at goes through restoreFocus; only Back/Forward may reopen the detail.
    expect(pending).toMatch(/if \(p\.fromLoad\) restoreFocus\(/);
    expect(pending).not.toMatch(/handleFocusTask\(|setSuppressDetail\(false\)/);
    // The saved layout's focused task, wherever it is read.
    const reads = [...main.matchAll(/readString\('homeFocusedTask'\)/g)].map((m) => m.index!);
    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const at of reads) {
      const after = main.slice(at, at + 400);
      const next = /(restoreFocus|setFocusedTask|handleFocusTask)\(/.exec(after);
      expect(next?.[1], 'a saved focus must come back through restoreFocus').toBe('restoreFocus');
    }
    // restoreFocus itself keeps the detail closed.
    const body = main.slice(main.indexOf('const restoreFocus'), main.indexOf('const restoreFocus') + 200);
    expect(body).toContain('setSuppressDetail(true)');
  });
});
