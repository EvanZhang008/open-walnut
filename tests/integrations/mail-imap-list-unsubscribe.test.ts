/**
 * `List-Unsubscribe`, `List-Unsubscribe-Post` and `List-Id` as they really arrive: from strangers.
 *
 * Every value graded here was written by whoever sent the mail, it is stored in a blob the list page
 * reads on every scroll, and from the unsubscribe ladder on, a url taken from it is one the SERVER
 * will fetch. So the table below is not tidiness: each row is a way a header can be hostile or
 * simply wrong, and the wanted answer is always "keep the usable part, drop the rest, never grow
 * without a bound".
 *
 * Two shapes cost real bugs elsewhere in this file's subject and are pinned here:
 *
 * - A FOLDED header is one value, not two. `parseHeaders` splits only at a newline that is NOT
 *   followed by whitespace, and a list that puts its https target on one line and its mailto on the
 *   next is the common real shape.
 * - mailparser's `headers` map is the WRONG source for these three. It folds every `List-*` header
 *   into one structured `list` entry holding a single url and a single mail address, so a message
 *   offering two targets loses one. `parseMime` reads `headerLines` instead, and the last block here
 *   grades that against the real parser rather than a fake.
 */
import { describe, it, expect } from 'vitest';
import {
  parseHeaders,
  parseListUnsubscribe,
  parseMime,
  toEnvelope,
} from '../../src/integrations/mail-imap/mime.js';
import type { MailListUnsubscribe } from '../../src/integrations/mail/types.js';

/** The headers as `parseHeaders` hands them over: lowercased names, already unfolded. */
function parse(headers: Record<string, string>): MailListUnsubscribe | undefined {
  return parseListUnsubscribe(headers);
}

describe('a well-formed newsletter', () => {
  it('keeps both targets, the one-click grant and the list key', () => {
    expect(parse({
      'list-unsubscribe': '<https://lists.example.invalid/u/1>, <mailto:leave@lists.example.invalid>',
      'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
      'list-id': '<news.example.invalid>',
    })).toEqual({
      https: ['https://lists.example.invalid/u/1'],
      mailto: ['mailto:leave@lists.example.invalid'],
      oneClick: true,
      listId: 'news.example.invalid',
    });
  });

  it('reads the list key out of a header that also carries a description, lowercased', () => {
    expect(parse({ 'list-id': 'Weekly Marina News <Weekly.Marina.EXAMPLE.invalid>' })?.listId)
      .toBe('weekly.marina.example.invalid');
  });

  it('falls back to the whole value when List-Id carries no angle brackets', () => {
    expect(parse({ 'list-id': ' News.Example.Invalid ' })?.listId).toBe('news.example.invalid');
  });

  it('keeps a mailto with a subject parameter whole, commas in the query included', () => {
    expect(parse({
      'list-unsubscribe': '<mailto:leave@lists.example.invalid?subject=unsubscribe,please>',
    })?.mailto).toEqual(['mailto:leave@lists.example.invalid?subject=unsubscribe,please']);
  });
});

describe('a hostile or simply wrong header', () => {
  it('drops a plaintext http target, and falls back to the rung that is left', () => {
    const http = parse({ 'list-unsubscribe': '<http://lists.example.invalid/u/1>' });
    expect(http).toBeUndefined();

    const mixed = parse({
      'list-unsubscribe': '<http://lists.example.invalid/u/1>, <mailto:leave@lists.example.invalid>',
    });
    expect(mixed).toEqual({ mailto: ['mailto:leave@lists.example.invalid'], oneClick: false });
  });

  it('keeps four https targets out of forty', () => {
    const forty = Array.from({ length: 40 }, (_, at) => `<https://lists.example.invalid/u/${at}>`).join(', ');
    expect(parse({ 'list-unsubscribe': forty })?.https).toEqual([
      'https://lists.example.invalid/u/0',
      'https://lists.example.invalid/u/1',
      'https://lists.example.invalid/u/2',
      'https://lists.example.invalid/u/3',
    ]);
  });

  it('keeps two mailto targets out of ten', () => {
    const ten = Array.from({ length: 10 }, (_, at) => `<mailto:leave${at}@lists.example.invalid>`).join(', ');
    expect(parse({ 'list-unsubscribe': ten })?.mailto).toEqual([
      'mailto:leave0@lists.example.invalid',
      'mailto:leave1@lists.example.invalid',
    ]);
  });

  it('clips a 10 KB url at 2048 characters rather than dropping it', () => {
    const long = `https://lists.example.invalid/u/${'x'.repeat(10 * 1024)}`;
    const parsed = parse({ 'list-unsubscribe': `<${long}>` });
    expect(parsed?.https).toHaveLength(1);
    expect(parsed!.https![0]!.length).toBe(2048);
    expect(parsed!.https![0]).toBe(long.slice(0, 2048));
  });

  it('never grows past the caps however many bracket groups the header holds', () => {
    // Walked lazily: this must be bounded work AND a bounded answer, not one or the other.
    const thousands = Array.from({ length: 5_000 }, (_, at) => `<https://x.example.invalid/${at}>`).join(',');
    const parsed = parse({ 'list-unsubscribe': thousands, 'list-id': '<news.example.invalid>' });
    expect(parsed?.https).toHaveLength(4);
    expect(JSON.stringify(parsed).length).toBeLessThan(400);
  });

  it('drops a mailto that is not an address, and a mailto naming several recipients', () => {
    // Both are real headers. `mailto:undisclosed-recipients:;` is the shape that used to turn Reply
    // into a 400 nobody could see, and "unsubscribe me" is never two recipients.
    expect(parse({ 'list-unsubscribe': '<mailto:undisclosed-recipients:;>' })).toBeUndefined();
    expect(parse({ 'list-unsubscribe': '<mailto:>' })).toBeUndefined();
    expect(parse({ 'list-unsubscribe': '<mailto:leave@lists.example.invalid,also@example.invalid>' }))
      .toBeUndefined();
    expect(parse({ 'list-unsubscribe': '<mailto:not-an-address>' })).toBeUndefined();
  });

  it('reads a percent-encoded address before shape-checking it', () => {
    expect(parse({ 'list-unsubscribe': '<mailto:leave%40lists.example.invalid>' })?.mailto)
      .toEqual(['mailto:leave%40lists.example.invalid']);
  });

  it('says oneClick: false when the companion header arrives with nothing to post to', () => {
    expect(parse({ 'list-unsubscribe-post': 'List-Unsubscribe=One-Click' })).toBeUndefined();
    expect(parse({
      'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
      'list-id': '<news.example.invalid>',
    })).toEqual({ oneClick: false, listId: 'news.example.invalid' });
  });

  it('says oneClick: false when the companion header says something else', () => {
    expect(parse({
      'list-unsubscribe': '<https://lists.example.invalid/u/1>',
      'list-unsubscribe-post': 'List-Unsubscribe=Two-Click',
    })?.oneClick).toBe(false);
    expect(parse({
      'list-unsubscribe': '<https://lists.example.invalid/u/1>',
      'list-unsubscribe-post': '  list-unsubscribe = ONE-CLICK  ',
    })?.oneClick).toBe(true);
  });

  it('answers undefined for a header that offers nothing usable at all', () => {
    expect(parse({})).toBeUndefined();
    expect(parse({ 'list-unsubscribe': '' })).toBeUndefined();
    expect(parse({ 'list-unsubscribe': 'NO' })).toBeUndefined();
    expect(parse({ 'list-unsubscribe': '<>' })).toBeUndefined();
    expect(parse({ 'list-unsubscribe': '<javascript:alert(1)>' })).toBeUndefined();
    expect(parse({ 'list-unsubscribe': '<data:text/html,hi>' })).toBeUndefined();
    expect(parse({ 'list-unsubscribe': '<file:///etc/passwd>' })).toBeUndefined();
  });

  it('reads an unbracketed value when it is one whole url, which real senders do emit', () => {
    expect(parse({ 'list-unsubscribe': ' https://lists.example.invalid/u/1 ' })?.https)
      .toEqual(['https://lists.example.invalid/u/1']);
    expect(parse({ 'list-unsubscribe': 'mailto:leave@lists.example.invalid' })?.mailto)
      .toEqual(['mailto:leave@lists.example.invalid']);
    // Not a url at all, so not a target. The value has to START with a scheme to be read at all.
    expect(parse({ 'list-unsubscribe': 'ask us nicely' })).toBeUndefined();
    expect(parse({ 'list-unsubscribe': 'unsubscribe at https://lists.example.invalid/u' })).toBeUndefined();
  });
});

describe('an unbracketed value carrying more than one target', () => {
  // Senders who skip the brackets also skip them when they offer both rungs, and the bug this pins is
  // the one that reads worst to a human: the two used to be glued into ONE https url whose path held
  // the mailto. `new URL` accepts it, the SSRF guard passes it (the host is fine), the request 404s,
  // and the console then reports "the unsubscribe page refused" about a list whose link was good.
  it.each([
    ['a comma and a space', 'https://lists.example.invalid/u, mailto:leave@lists.example.invalid'],
    ['a bare comma', 'https://lists.example.invalid/u,mailto:leave@lists.example.invalid'],
    ['only whitespace', 'https://lists.example.invalid/u mailto:leave@lists.example.invalid'],
    ['a newline the unfolder left', 'https://lists.example.invalid/u,\tmailto:leave@lists.example.invalid'],
  ])('is split into its targets when separated by %s', (_how, value) => {
    expect(parse({ 'list-unsubscribe': value })).toEqual({
      https: ['https://lists.example.invalid/u'],
      mailto: ['mailto:leave@lists.example.invalid'],
      oneClick: false,
    });
  });

  it('reads the same value the same way whether or not the sender used brackets', () => {
    const bare = 'https://lists.example.invalid/u, mailto:leave@lists.example.invalid';
    const bracketed = '<https://lists.example.invalid/u>, <mailto:leave@lists.example.invalid>';
    expect(parse({ 'list-unsubscribe': bare })).toEqual(parse({ 'list-unsubscribe': bracketed }));
  });

  it('splits only where a new target begins, so a comma inside one url survives', () => {
    // The reason the fallback did not split before. Both of these are ONE target.
    expect(parse({ 'list-unsubscribe': 'mailto:leave@lists.example.invalid?subject=unsubscribe,please' })?.mailto)
      .toEqual(['mailto:leave@lists.example.invalid?subject=unsubscribe,please']);
    expect(parse({ 'list-unsubscribe': 'https://lists.example.invalid/u?ids=1,2,3&from=a,b' })?.https)
      .toEqual(['https://lists.example.invalid/u?ids=1,2,3&from=a,b']);
  });

  it('drops the http half and keeps the mailto, exactly as the bracketed path does', () => {
    expect(parse({ 'list-unsubscribe': 'http://lists.example.invalid/u, mailto:leave@lists.example.invalid' }))
      .toEqual({ mailto: ['mailto:leave@lists.example.invalid'], oneClick: false });
    expect(parse({ 'list-unsubscribe': 'http://lists.example.invalid/u' })).toBeUndefined();
  });

  it('applies every bound the bracketed path applies', () => {
    const many = Array.from({ length: 40 }, (_, at) => `https://lists.example.invalid/u/${at}`).join(', ');
    expect(parse({ 'list-unsubscribe': many })?.https).toHaveLength(4);

    const mailtos = Array.from({ length: 10 }, (_, at) => `mailto:leave${at}@lists.example.invalid`).join(', ');
    expect(parse({ 'list-unsubscribe': mailtos })?.mailto).toHaveLength(2);

    const long = `https://lists.example.invalid/u/${'x'.repeat(10 * 1024)}`;
    const clipped = parse({ 'list-unsubscribe': `${long}, mailto:leave@lists.example.invalid` });
    expect(clipped?.https?.[0]?.length).toBe(2048);
    expect(clipped?.mailto).toEqual(['mailto:leave@lists.example.invalid']);

    // Bounded work AND a bounded answer, the same property the bracketed path is graded on.
    const thousands = Array.from({ length: 5_000 }, (_, at) => `https://x.example.invalid/${at}`).join(',');
    const parsed = parse({ 'list-unsubscribe': thousands });
    expect(parsed?.https).toHaveLength(4);
    expect(JSON.stringify(parsed).length).toBeLessThan(400);
  });
});

describe('a folded header', () => {
  const RAW = [
    'Message-ID: <weekly-42@lists.example.invalid>',
    'Date: Mon, 21 Sep 2026 09:00:00 -0700',
    'List-Unsubscribe: <https://lists.example.invalid/u/abc>,',
    '\t<mailto:leave@lists.example.invalid?subject=unsubscribe>',
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    'List-Id: Marina Weekly',
    ' <weekly.lists.example.invalid>',
  ].join('\r\n');

  it('is one value, so both targets survive the unfolding', () => {
    const parsed = parseHeaders(RAW);
    expect(parseListUnsubscribe(parsed)).toEqual({
      https: ['https://lists.example.invalid/u/abc'],
      mailto: ['mailto:leave@lists.example.invalid?subject=unsubscribe'],
      oneClick: true,
      listId: 'weekly.lists.example.invalid',
    });
  });

  it('rides the envelope a poll builds, alongside everything else it reads', () => {
    const envelope = toEnvelope('INBOX', '9001', {
      uid: 42,
      headers: RAW,
      envelope: {
        messageId: '<weekly-42@lists.example.invalid>',
        subject: 'Marina Weekly, issue 42',
        from: [{ name: 'Marina Weekly', address: 'weekly@lists.example.invalid' }],
        to: [{ address: 'reader@example.invalid' }],
        date: new Date(Date.UTC(2026, 8, 21, 16, 0, 0)),
      },
      flags: new Set(['\\Seen']),
    } as never);

    expect(envelope.listUnsubscribe).toEqual({
      https: ['https://lists.example.invalid/u/abc'],
      mailto: ['mailto:leave@lists.example.invalid?subject=unsubscribe'],
      oneClick: true,
      listId: 'weekly.lists.example.invalid',
    });
    // The rest of the envelope is untouched by the new reading.
    expect(envelope.subject).toBe('Marina Weekly, issue 42');
    expect(envelope.messageId).toBe('INBOX:9001:42');
  });

  it('is absent from an ordinary message, so no key is written for one', () => {
    const plain = toEnvelope('INBOX', '9001', {
      uid: 7,
      headers: 'Message-ID: <hello@example.invalid>\r\nSubject: hello',
      envelope: { messageId: '<hello@example.invalid>', subject: 'hello', from: [{ address: 'a@example.invalid' }] },
      flags: new Set<string>(),
    } as never);
    expect(plain.listUnsubscribe).toBeUndefined();
    expect('listUnsubscribe' in plain).toBe(false);
  });
});

describe('a BODY parse, through the real mailparser', () => {
  function rawMail(lines: string[]): Buffer {
    return Buffer.from([...lines, 'Content-Type: text/plain', '', 'Nothing much.', ''].join('\r\n'));
  }

  it('carries the three headers out of headerLines, folding included', async () => {
    const parsed = await parseMime(rawMail([
      'From: Marina Weekly <weekly@lists.example.invalid>',
      'Subject: Issue 42',
      'List-Unsubscribe: <https://lists.example.invalid/u/abc>,',
      ' <mailto:leave@lists.example.invalid>',
      'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
      'List-Id: Marina Weekly <weekly.lists.example.invalid>',
    ]));

    // The whole point of reading headerLines: mailparser's own structured `list` entry keeps ONE
    // url and ONE mail address, so both of these would not survive a `headers.get('list')` reading.
    expect(parseListUnsubscribe(parsed.headers ?? {})).toEqual({
      https: ['https://lists.example.invalid/u/abc'],
      mailto: ['mailto:leave@lists.example.invalid'],
      oneClick: true,
      listId: 'weekly.lists.example.invalid',
    });
  });

  it('carries NOTHING but those three, whatever else the message piles on', async () => {
    const noisy = Array.from({ length: 200 }, (_, at) => `X-Spam-Score-${at}: ${at}`);
    const parsed = await parseMime(rawMail([
      'From: Marina Weekly <weekly@lists.example.invalid>',
      'Subject: Issue 43',
      ...noisy,
      'List-Id: <weekly.lists.example.invalid>',
    ]));
    expect(Object.keys(parsed.headers ?? {})).toEqual(['list-id']);
    expect(parsed.text?.trim()).toBe('Nothing much.');
  });

  it('leaves the field off entirely for a message with no List-* header', async () => {
    const parsed = await parseMime(rawMail([
      'From: A Person <person@example.invalid>',
      'Subject: hello',
    ]));
    expect(parsed.headers).toBeUndefined();
  });
});
