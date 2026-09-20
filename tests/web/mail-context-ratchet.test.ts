/**
 * The grep layer over the mail right-click slice: the anti-patterns that a passing UI still hides.
 *
 * A Playwright spec proves a menu appears in the right place. It cannot prove HOW: a second portal, a
 * second clamp, a second Escape handler and a second copy of the keep-the-native-menu rules all look
 * identical on screen and rot separately. Four things are pinned here, each one a rule the slice was
 * given rather than a taste:
 *
 *  - placement, dismissal and arrow keys belong to `components/common/ContextMenu.tsx` (C1);
 *  - every right-click call site opens through `useContextMenu`, and none of them claims links (C2);
 *  - the EDITABLE / MEDIA / LINK selector set lives in ONE file (C29);
 *  - the optimistic read flip lives in `mail-read-flag.ts`, so a rollback can only be written once;
 *  - `mail.css` gained row marks, not a private menu (C42 / C76), and no row grew an `<a href>` (C57).
 *
 * Scoped to the files the spec's section 9 names, not to the whole directory: `AddAccountDialog.tsx`
 * portals a dialog and has done since before this slice, and the message list has answered Escape in
 * its SEARCH BOX for as long. A ban that swept those up would be edited away the first time it fired.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MAIL_DIR = path.resolve(__dirname, '../../web/src/apps/mail');

/** The files this slice writes or changes (spec section 9). Missing ones are simply not graded. */
const SLICE_FILES = [
  'MailRowContextMenu.tsx',
  'MailFolderContextMenu.tsx',
  'mail-context-items.ts',
  'MailMessageList.tsx',
  'MailAccountFolders.tsx',
  'MailSmartRows.tsx',
  'mail-read-flag.ts',
  'mail-actions.ts',
  'mail-store.ts',
  'mail-unread-filter.ts',
  'mail-task-actions.ts',
];

function read(file: string): string | null {
  const full = path.join(MAIL_DIR, file);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

/** Every `.ts`/`.tsx` under the mail app, one level of `compose/` included. */
function mailSources(): { file: string, text: string }[] {
  const out: { file: string, text: string }[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { walk(path.join(dir, entry.name), `${prefix}${entry.name}/`); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      out.push({ file: `${prefix}${entry.name}`, text: fs.readFileSync(path.join(dir, entry.name), 'utf8') });
    }
  };
  walk(MAIL_DIR, '');
  return out;
}

const slice = (): { file: string, text: string }[] =>
  SLICE_FILES.map((file) => ({ file, text: read(file) }))
    .filter((one): one is { file: string, text: string } => one.text !== null);

/**
 * Comments blanked, newlines kept, so a line number still points at the real line.
 *
 * Every rule here is about CODE. The comments in these files quote the anti-patterns they exist to
 * forbid ("never an `<a href>`", "Escape is the shared menu's"), so scanning the raw text makes the
 * documentation the offender and teaches the next author to delete the explanation.
 */
function withoutComments(text: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, ' ');
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, (match, lead: string) => `${lead}${blank(match.slice(lead.length))}`);
}

/** Lines of a file that match, as `file:line text`, so a failure names the offender. */
function hits(file: string, text: string, pattern: RegExp): string[] {
  return withoutComments(text).split('\n')
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => pattern.test(line) && !line.startsWith('*') && !line.startsWith('//'))
    .map(({ line, number }) => `${file}:${number} ${line}`);
}

describe('C1 the shared primitive owns the menu', () => {
  it('no slice file portals anything itself', () => {
    const found = slice().flatMap(({ file, text }) => hits(file, text, /createPortal|ReactDOM\.createPortal/));
    expect(found).toEqual([]);
  });

  it('no slice file computes a fixed-position placement', () => {
    // The three ingredients of a hand-rolled clamp: a fixed box, the viewport's size, and the
    // measurement it is compared against. `useMenuPlacement` is the only thing allowed to hold them.
    const found = slice().flatMap(({ file, text }) => hits(
      file,
      text,
      /position:\s*['"]fixed['"]|window\.innerHeight|window\.innerWidth|getBoundingClientRect\(\)\.bottom/,
    ));
    expect(found).toEqual([]);
  });

  it('Escape is answered only by the search box that answered it before this slice', () => {
    // MailMessageList.tsx clears its search input on Escape and predates the menu. Any OTHER Escape
    // line in a slice file is a second dismisser racing the one inside ContextMenu.tsx.
    const found = slice()
      .flatMap(({ file, text }) => hits(file, text, /['"]Escape['"]/))
      .filter((line) => !(line.startsWith('MailMessageList.tsx') && line.includes('search.active')));
    expect(found).toEqual([]);
  });

  it('no slice file steers a menu with the arrow keys, Home or End', () => {
    const found = slice().flatMap(({ file, text }) => hits(
      file,
      text,
      /['"]ArrowDown['"]|['"]ArrowUp['"]|key === ['"]Home['"]|key === ['"]End['"]/,
    ));
    expect(found).toEqual([]);
  });
});

describe('C2 every right-click call site is the shared hook', () => {
  it('a file that handles onContextMenu also uses useContextMenu', () => {
    const offenders = mailSources()
      .filter(({ text }) => /onContextMenu=/.test(text))
      .filter(({ text }) => !/useContextMenu/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it('no call site claims links with overrideLinks', () => {
    // The rows are <button>s. Claiming links would take the browser's menu off a real document link
    // (the reader body, a task pill) for no gain, and rule 6 says those rules live in one place.
    const found = mailSources().flatMap(({ file, text }) => hits(file, text, /overrideLinks/));
    expect(found).toEqual([]);
  });

  it('the row, folder and smart menus are mounted somewhere in the mail app', () => {
    // Filename-agnostic on purpose: what is graded is that the three menus the spec names exist and
    // carry the testIds every other check in this slice looks them up by.
    const text = mailSources().map((one) => one.text).join('\n');
    // The ids, not the corpus, are what a failure should print.
    const missing = ['mail-row-ctx-menu', 'mail-folder-ctx-menu', 'mail-smart-ctx-menu']
      .filter((testId) => !text.includes(testId));
    expect(missing).toEqual([]);
  });
});

describe('C29 the keep-the-native-menu rules exist once', () => {
  it('the EDITABLE, MEDIA and LINK selector sets are only in utils/context-menu.ts', () => {
    const shared = fs.readFileSync(path.resolve(__dirname, '../../web/src/utils/context-menu.ts'), 'utf8');
    expect(shared).toContain('input, textarea, select');
    expect(shared).toContain('img, video, audio');
    expect(shared).toContain('a[href]');
    const copies = mailSources().flatMap(({ file, text }) => hits(
      file,
      text,
      /input, textarea|img, video|closest\(['"]a\[href\]/,
    ));
    expect(copies).toEqual([]);
  });

  it('no mail file re-decides the exemptions after preventDefault', () => {
    // Reading the selection itself is how a second copy of rule 6 starts. The hook already hands
    // `keepNativeContextMenu` the selection and the row as scope.
    // The one exemption is the row's own CLICK gate (`selectingInside`), which asks a different
    // question: a drag that ended inside the row must not open the message. It lives with the row
    // in MailMessageRow.tsx, so the list file is no longer allowed to read a selection either.
    const found = mailSources().flatMap(({ file, text }) => hits(file, text, /window\.getSelection\(\)/))
      .filter((line) => !line.startsWith('MailMessageRow.tsx'));
    expect(found).toEqual([]);
  });
});

describe('the optimistic read flip has one home', () => {
  it('markMailMessageRead is called only from mail-read-flag.ts', () => {
    const found = mailSources()
      .filter(({ file }) => file !== 'mail-read-flag.ts')
      .flatMap(({ file, text }) => hits(file, text, /markMailMessageRead/));
    expect(found).toEqual([]);
  });

  it('applySeen and the SEEN flag are only patched in mail-read-flag.ts', () => {
    const found = mailSources()
      .filter(({ file }) => file !== 'mail-read-flag.ts' && file !== 'mail-store.ts' && file !== 'mail-format.ts')
      .flatMap(({ file, text }) => hits(file, text, /applySeen|flags:\s*\[/));
    expect(found).toEqual([]);
  });
});

describe('C42 and C76 mail.css gained row marks, not a private menu', () => {
  const css = fs.readFileSync(path.join(MAIL_DIR, 'mail.css'), 'utf8');
  const cssFiles = fs.readdirSync(MAIL_DIR).filter((one) => one.endsWith('.css'));

  it('no mail stylesheet styles the shared menu', () => {
    for (const file of cssFiles) {
      const text = fs.readFileSync(path.join(MAIL_DIR, file), 'utf8');
      const selectors = text.split('\n').filter((line) => /^[.#[:a-zA-Z].*\{/.test(line.trim()));
      expect(selectors.filter((one) => /wn-context/.test(one)), `${file} styles the shared menu`).toEqual([]);
    }
  });

  it('the marks the slice added are only the ones the spec lists', () => {
    // A closed set of NAMES rather than of formatted lines: the rules are being edited while this is
    // written, and what matters is that nothing beyond a row mark appeared, not where the brace sits.
    const allowed = ['data-ctx-open', 'mail-row-task', 'data-flag-failed', 'mail-row-flag-failed', 'mail-mailbox-fetch'];
    const selectors = css.split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[.[][^{;]*[,{]$/.test(line))
      .filter((line) => /ctx|flag-failed|row-task|mailbox-fetch/.test(line));
    for (const selector of selectors) {
      expect(
        allowed.some((name) => selector.includes(name)),
        `mail.css selector outside the slice's row marks: ${selector}`,
      ).toBe(true);
    }
    expect(selectors.length).toBeGreaterThan(0);
  });

  it('no mail rule sets a menu width or a menu colour', () => {
    // The width cap is the primitive's `min(340px, 100vw - 16px)` and the colours are its own tokens;
    // a mail-private copy would drift from the tasks and calendar menus, which rule 1 forbids.
    const blocks = css.split('}').filter((block) => /ctx|context menu|wn-context/.test(block.split('{')[0] ?? ''));
    for (const block of blocks) {
      const body = block.split('{')[1] ?? '';
      const selector = (block.split('{')[0] ?? '').trim().split('\n').pop() ?? '';
      expect(hits(`mail.css rule ${selector}`, body, /(^|\s)(max-width|min-width|width|font-size|color):/)).toEqual([]);
    }
  });

  it('the subject and the snippet are selectable text', () => {
    // The G15 pair: without these two there can be no selection in a row, so the browser's own menu
    // (Copy, Look Up) can never win a right-click and C26 cannot be tested at all.
    expect(css).toMatch(/\.mail-row-subject-text,\s*\n\s*\.mail-row-snippet \{ user-select: text; \}/);
  });
});

describe('C57 a message row grew a glyph, not a link', () => {
  it('the message list holds no anchor', () => {
    // `MailTaskButton` renders an <a href>, and LINK in the shared rules hands any subtree containing
    // one back to the browser: a task mark that was a link would silently disable the row's own menu.
    const list = read('MailMessageList.tsx');
    expect(list).not.toBeNull();
    expect(hits('MailMessageList.tsx', list!, /<a\s|href=/)).toEqual([]);
    expect(withoutComments(list!)).not.toContain('MailTaskButton');
  });
});
