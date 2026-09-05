/**
 * Addresses as the composer holds them: one chip per recipient, valid or not.
 *
 * A chip keeps the RAW text the human typed alongside the parsed pair, and that is the point: an
 * address the server will refuse has to stay on screen, in the words it was written in, so the
 * typo is visible and fixable. Dropping it (or silently repairing it) is how a mail goes to three
 * of the four people it was addressed to.
 *
 * The validity test MIRRORS the server's (`src/integrations/mail/drafts.ts`): one `@`, a dot in
 * the domain, no whitespace. Deliberately not an RFC 5322 grammar, which accepts things no mail
 * server will and refuses things some will; the transport is the authority and this only catches
 * the obvious typo before a human is asked to approve it.
 *
 * Pure and DOM-free, so `tests/web/mail-compose-address.test.ts` grades it directly.
 */
import type { MailAddress } from '@/api/mail';

/** Same shape as the server's check, so a chip this file calls valid is one it will accept. */
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Characters that separate two recipients, when they are not inside a name or an angle pair. */
const SEPARATORS = new Set([',', ';', '\n', '\r']);

export interface AddressChip {
  /** Stable across re-renders and independent of the list index. */
  key: string;
  /** Exactly what was typed or pasted, kept so an invalid chip can be shown and fixed. */
  raw: string;
  name?: string;
  address: string;
  valid: boolean;
}

let sequence = 0;

/**
 * Split typed or pasted text into one fragment per recipient.
 *
 * Scanned rather than `split()`, because a comma is only a separator OUTSIDE a quoted display name
 * and outside an angle pair. `"Doe, Jane" <j@x.y>` is exactly what a paste out of a mail client
 * looks like, and splitting it on the comma produced a chip called `"Doe` that the human then had to
 * repair by hand.
 *
 * Whitespace separates only inside a fragment that carries no display name (no `<` and no quote) and
 * holds more than one `@`: without that guard `Keeper Reports <keeper@example.invalid>` becomes
 * three broken chips, and with it a pasted column of bare addresses becomes one chip each.
 */
export function splitAddressText(text: string): string[] {
  const fragments: string[] = [];
  let current = '';
  let inQuote = false;
  let inAngle = false;
  const flush = () => {
    for (const part of expandBareList(current)) fragments.push(part);
    current = '';
  };
  for (const char of text) {
    if (char === '"' && !inAngle) inQuote = !inQuote;
    else if (char === '<' && !inQuote) inAngle = true;
    else if (char === '>' && !inQuote) inAngle = false;
    else if (SEPARATORS.has(char) && !inQuote && !inAngle) { flush(); continue; }
    current += char;
  }
  flush();
  return fragments;
}

/** One fragment, or its words when it is plainly a whitespace-separated list of bare addresses. */
function expandBareList(fragment: string): string[] {
  const trimmed = fragment.trim();
  if (!trimmed) return [];
  if (trimmed.includes('<') || trimmed.includes('"')) return [trimmed];
  const words = trimmed.split(/\s+/);
  const looksLikeList = words.length > 1 && words.every((word) => word.includes('@'));
  return looksLikeList ? words : [trimmed];
}

/** One fragment as a chip. `Name <a@b.c>`, `<a@b.c>` and a bare address all land here. */
export function parseAddressChip(raw: string): AddressChip {
  const text = raw.trim();
  const angled = /^(.*?)<([^<>]*)>$/.exec(text);
  const address = (angled ? angled[2] : text).trim();
  const name = angled ? unquote(angled[1]!.trim()) : '';
  return {
    key: `ac-${++sequence}`,
    raw: text,
    ...(name ? { name } : {}),
    address,
    // A line break in a display name is header injection (it could add a Bcc), so a chip
    // carrying one is invalid here rather than a 400 after the human pressed send.
    valid: ADDRESS.test(address) && !/[\r\n]/.test(name),
  };
}

/** Every recipient in a blob of typed or pasted text, in the order it was written. */
export function chipsFrom(text: string): AddressChip[] {
  return splitAddressText(text).map((fragment) => parseAddressChip(fragment));
}

/**
 * Add text to a list, dropping a recipient the list already holds.
 *
 * Case-insensitive on the address, because a mail server is: `Alice@x` and `alice@x` are one
 * person, and sending them both is how a reply-all embarrasses somebody.
 */
export function withChips(existing: AddressChip[], text: string): AddressChip[] {
  const known = new Set(existing.filter((chip) => chip.valid).map((chip) => addressKey(chip)));
  const next = [...existing];
  for (const chip of chipsFrom(text)) {
    if (chip.valid && known.has(addressKey(chip))) continue;
    if (chip.valid) known.add(addressKey(chip));
    next.push(chip);
  }
  return next;
}

export function addressKey(address: { address: string }): string {
  return address.address.trim().toLowerCase();
}

/** The chips a draft may be saved with. An invalid one is kept on screen, never sent. */
export function validAddresses(chips: AddressChip[]): MailAddress[] {
  return chips
    .filter((chip) => chip.valid)
    .map((chip) => ({ ...(chip.name ? { name: chip.name } : {}), address: chip.address }));
}

export function hasInvalidAddress(chips: AddressChip[]): boolean {
  return chips.some((chip) => !chip.valid);
}

/** Chips for addresses that came from the server, which are already parsed. */
export function chipsOf(addresses: MailAddress[] | undefined): AddressChip[] {
  return (addresses ?? []).map((one) => ({
    key: `ac-${++sequence}`,
    raw: one.name ? `${one.name} <${one.address}>` : one.address,
    ...(one.name ? { name: one.name } : {}),
    address: one.address,
    valid: ADDRESS.test(one.address),
  }));
}

/** What a chip says on screen: the name when there is one, the address otherwise. */
export function chipLabel(chip: AddressChip): string {
  if (!chip.valid) return chip.raw || chip.address;
  return chip.name || chip.address;
}

function unquote(value: string): string {
  const quoted = /^"(.*)"$/.exec(value);
  return (quoted ? quoted[1]! : value).trim();
}
