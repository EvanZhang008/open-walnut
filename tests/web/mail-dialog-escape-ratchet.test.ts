/**
 * Every Mail dialog hears Escape on the DOCUMENT, not only on itself.
 *
 * WebKit, the Mac app's engine, focuses nothing a click lands on: after one click on a tick box or a
 * button inside a dialog, focus sits on <body>, and a dialog that listened for Escape only through its
 * own `onKeyDown` never heard the key again (2026-11-01: the unsubscribe checklist stayed open after
 * its batch, mail-grouping-unsub.spec.ts). A dialog here registers a document `keydown` listener or
 * goes through `useModalOverlay`, which does.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MAIL_DIR = path.resolve(__dirname, '../../web/src/apps/mail');

function sources(dir: string, prefix = ''): { file: string; text: string }[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return sources(path.join(dir, entry.name), `${prefix}${entry.name}/`);
    if (!/\.tsx$/.test(entry.name)) return [];
    return [{ file: `${prefix}${entry.name}`, text: fs.readFileSync(path.join(dir, entry.name), 'utf8') }];
  });
}

const hearsDocument = (text: string): boolean => (
  /document\.addEventListener\(\s*'keydown'/.test(text) || /\buseModalOverlay\(/.test(text)
);

describe('Mail dialogs and Escape', () => {
  const dialogs = sources(MAIL_DIR).filter(({ text }) => text.includes('role="dialog"'));

  it('finds the dialogs it grades', () => {
    expect(dialogs.map((one) => one.file)).toContain('MailUnsubscribePlanDialog.tsx');
  });

  it('every one hears Escape on the document', () => {
    expect(dialogs.filter(({ text }) => !hearsDocument(text)).map((one) => one.file)).toEqual([]);
  });

  it('catches the shape it was written for', () => {
    expect(hearsDocument('<div role="dialog" onKeyDown={(event) => { if (event.key === \'Escape\') onClose(); }}>')).toBe(false);
  });
});
