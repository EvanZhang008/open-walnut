/**
 * An address in a mail row or the reader breaks as a unit: after its "@" and nowhere else unless
 * one half is longer than the line (2026-11-22 review: "noreply@longmeadowgardensupply.org" in a
 * list row wrapped a lone ".org" under the subject). Every place that prints a sender or recipient
 * as a row's or the reader's name goes through AddressWords; a new one that prints the bare label
 * fails here.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { addressParts } from '../../web/src/apps/mail/AddressWords';

const MAIL = path.resolve(__dirname, '../../web/src/apps/mail');
const read = (f: string) => fs.readFileSync(path.join(MAIL, f), 'utf8');

describe('an address breaks only after its "@"', () => {
  it('splits a bare address once and leaves a name whole', () => {
    expect(addressParts('notices@bakery.example.org')).toEqual(['notices@', 'bakery.example.org']);
    expect(addressParts('North Garden Bakery')).toEqual(['North Garden Bakery']);
    expect(addressParts('Garden desk <desk@garden.example>')).toEqual(['Garden desk <desk@garden.example>']);
    expect(addressParts('Unknown sender')).toEqual(['Unknown sender']);
  });

  it('every row and reader name of a sender or recipient prints through AddressWords', () => {
    const files = fs.readdirSync(MAIL).filter((f) => /\.tsx$/.test(f));
    const bare: string[] = [];
    for (const f of files) {
      const src = read(f);
      // A sender's label as an element's whole text: {senderLabel(...)} directly between tags.
      for (const m of src.matchAll(/>\s*\{(?:outbound \? [^}]*: )?senderLabel\([^)]*\)\}\s*</g)) bare.push(`${f}: ${m[0].trim()}`);
    }
    expect(bare, 'Print it as <AddressWords text={...} /> (web/src/apps/mail/AddressWords.tsx)').toEqual([]);
    for (const f of ['MailGroupLine.tsx', 'MailMessageRow.tsx', 'MailReaderHead.tsx']) expect(read(f), f).toMatch(/<AddressWords text=\{/);
  });
});
