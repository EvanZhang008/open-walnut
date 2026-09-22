/**
 * Reading an unsubscribe page, which is prose nobody standardised.
 *
 * RFC 8058 standardised the one-click POST and said nothing about the page a GET lands on, so this is
 * a judgement over wording written by whoever runs the list. The two rules being graded here are the
 * two ways it can lie:
 *
 * - NO SIGNAL MUST NOT READ AS SUCCESS. A marketing homepage with a 200 is the commonest outcome of a
 *   tracking link, and calling it `done` tells the human they left a list that still has them.
 * - THE BARE VERB IS NOT A PAST TENSE. "Are you sure you want to unsubscribe?" is a question. Only a
 *   statement of the new state counts, which is why every pattern is past tense or explicit.
 *
 * Every fixture below is invented wording in the shape real newsletters use. None of it is copied
 * from anyone's mail.
 */
import { describe, expect, it } from 'vitest';
import {
  unsubscribeSentence,
  unsubscribeVerdict,
  UNSUBSCRIBE_DETAIL_CHARS,
} from '../../src/integrations/mail/unsubscribe-verdict.js';

function page(body: string, status = 200): { status: number; body: string; contentType: string } {
  return { status, body, contentType: 'text/html; charset=utf-8' };
}

describe('the four page classes', () => {
  it('reads a confirmation of success as done', () => {
    const verdict = unsubscribeVerdict(page(
      '<html><body><h1>All done</h1><p>You have been unsubscribed from this list.</p></body></html>',
    ));
    expect(verdict.status).toBe('done');
    expect(verdict.detail).toContain('You have been unsubscribed');
  });

  it('reads a page that wants a button pressed as needs-human, with the form named', () => {
    const verdict = unsubscribeVerdict(page(`
      <html><body>
        <p>Please confirm that you want to stop receiving the marina newsletter.</p>
        <form method="post" action="/unsubscribe/confirm">
          <input type="hidden" name="token" value="opaque">
          <button type="submit">Yes, unsubscribe me</button>
        </form>
      </body></html>
    `));
    expect(verdict).toMatchObject({ status: 'needs-human', reason: 'confirm-form' });
  });

  it('reads a marketing homepage as unclear rather than as success', () => {
    const verdict = unsubscribeVerdict(page(`
      <html><body>
        <h1>The Marina Company</h1>
        <p>Boats, moorings and weather since 1998. Browse our catalogue.</p>
        <form action="/search"><input name="q"><button>Search</button></form>
      </body></html>
    `));
    expect(verdict).toMatchObject({ status: 'needs-human', reason: 'unclear' });
  });

  it('reads a refusal as failed, naming the code', () => {
    expect(unsubscribeVerdict(page('<h1>Forbidden</h1>', 403)))
      .toMatchObject({ status: 'failed', reason: 'http-403' });
    expect(unsubscribeVerdict(page('<h1>Gone</h1>', 410)))
      .toMatchObject({ status: 'failed', reason: 'http-410' });
    expect(unsubscribeVerdict(page('<h1>Not found</h1>', 404)))
      .toMatchObject({ status: 'failed', reason: 'http-404' });
    expect(unsubscribeVerdict(page('<h1>Slow down</h1>', 429)))
      .toMatchObject({ status: 'failed', reason: 'http-429' });
  });

  it('reads a server fault as unreachable, which is the same word a dead socket gets', () => {
    expect(unsubscribeVerdict(page('<h1>Something went wrong</h1>', 500)))
      .toMatchObject({ status: 'failed', reason: 'unreachable' });
    expect(unsubscribeVerdict(page('', 503)))
      .toMatchObject({ status: 'failed', reason: 'unreachable' });
  });

  it('reads a redirect that reached the verdict reader as a broken endpoint', () => {
    // The hop loop handles real redirects, so this only happens when one arrived with no Location.
    expect(unsubscribeVerdict(page('', 302)))
      .toMatchObject({ status: 'failed', reason: 'unreachable' });
  });
});

describe('newsletter footer wordings that mean it worked', () => {
  it.each([
    'You have been unsubscribed. It may take a day for the last mail to stop.',
    'You were removed from the marina weekly list.',
    'You are now unsubscribed from all updates.',
    'You will no longer receive messages at this address.',
    'You have been removed from this mailing list.',
    'Your preferences have been saved. Nothing further will be sent.',
    'Unsubscribed. Sorry to see you go!',
    'You have opted out of marketing mail.',
  ])('reads "%s" as done', (sentence) => {
    expect(unsubscribeVerdict(page(`<html><body><p>${sentence}</p></body></html>`)).status).toBe('done');
  });

  it.each([
    'Are you sure you want to unsubscribe from the marina weekly list?',
    'Click the button below to unsubscribe.',
    'To manage your preferences, sign in to your account.',
    'Unsubscribe from this list',
    'We could not find your subscription. Please check the link in your mail.',
  ])('does NOT read "%s" as done', (sentence) => {
    expect(unsubscribeVerdict(page(`<html><body><p>${sentence}</p></body></html>`)).status)
      .not.toBe('done');
  });

  it('prefers the success wording over a search form on the same page', () => {
    // A confirmation page can carry the site's own chrome; the statement of the new state wins.
    const verdict = unsubscribeVerdict(page(`
      <p>You have been unsubscribed.</p>
      <form action="/unsubscribe/again"><button>Unsubscribe from something else</button></form>
    `));
    expect(verdict.status).toBe('done');
  });
});

describe('what the ledger is handed', () => {
  it('quotes the page in words, never in markup, and clips the quote', () => {
    const verdict = unsubscribeVerdict(page(
      `<html><head><style>p{color:red}</style></head><body><p>${'long prose '.repeat(200)}</p></body></html>`,
    ));
    expect(verdict.detail!.length).toBeLessThanOrEqual(UNSUBSCRIBE_DETAIL_CHARS);
    expect(verdict.detail).not.toContain('<');
    expect(verdict.detail).not.toContain('color:red');
  });

  it('judges a plain-text answer without pretending it is markup', () => {
    const verdict = unsubscribeVerdict({
      status: 200,
      contentType: 'text/plain',
      body: 'You have been unsubscribed from weekly@lists.example.invalid.',
    });
    expect(verdict.status).toBe('done');
  });

  /**
   * A DOWNLOAD IS NOT AN ANSWER. The success wordings are ordinary English, so a PDF or a
   * spreadsheet whose bytes happen to contain them would otherwise be reported as `done` — a
   * confident wrong answer about a list the person is still on. A response that SAID it was not a
   * page is never searched; one that said nothing still is, because mail-grade endpoints omit it.
   */
  it('refuses to read the words out of a file that is not a page', () => {
    const claims = 'You have been unsubscribed from this list.';
    for (const type of ['application/pdf', 'application/octet-stream', 'image/png', 'application/pdf; charset=binary']) {
      expect(unsubscribeVerdict({ status: 200, contentType: type, body: claims }), type)
        .toMatchObject({ status: 'needs-human', reason: 'not-a-page' });
    }
    // The readable ones keep their verdict, including the charset parameter form and no type at all.
    for (const type of ['text/html; charset=utf-8', 'text/plain', 'application/xhtml+xml', undefined]) {
      expect(unsubscribeVerdict({ status: 200, ...(type ? { contentType: type } : {}), body: claims }), String(type))
        .toMatchObject({ status: 'done' });
    }
    // And a refusal is still judged by its CODE: the content type says nothing about a 403.
    expect(unsubscribeVerdict({ status: 403, contentType: 'application/pdf', body: claims }))
      .toMatchObject({ status: 'failed', reason: 'http-403' });
  });

  it('calls an empty 200 unclear, because nothing said anything', () => {
    expect(unsubscribeVerdict({ status: 200, body: '' }))
      .toMatchObject({ status: 'needs-human', reason: 'unclear' });
  });

  it('never reads past the cap, so a huge page cannot hide its own verdict cost', () => {
    const padding = '<span>filler</span>'.repeat(40_000);
    const verdict = unsubscribeVerdict(page(`${padding}<p>You have been unsubscribed.</p>`));
    // The success wording is beyond 256 KB, so it is honestly reported as unclear rather than found
    // by reading a body the transport already refused to download.
    expect(padding.length).toBeGreaterThan(256 * 1024);
    expect(verdict.status).toBe('needs-human');
  });

  it('ignores an unclosed form tag instead of letting it swallow the rest of the page', () => {
    const verdict = unsubscribeVerdict(page(
      '<form action="/newsletter-signup"><input name="email">'
      + `<p>${'ordinary copy '.repeat(500)}</p>`
      + '<p>unsubscribe requests are handled by support</p>',
    ));
    // The signup form is 4 KB away from the word, so it is not read as a confirmation form.
    expect(verdict).toMatchObject({ status: 'needs-human', reason: 'unclear' });
  });
});

describe('the sentence a console prints', () => {
  it('says what happened, in words, for every outcome', () => {
    expect(unsubscribeSentence({ status: 'done', method: 'one-click' }))
      .toBe("Unsubscribed using the sender's one-click link.");
    expect(unsubscribeSentence({ status: 'needs-human', method: 'link', reason: 'confirm-form' }))
      .toContain('wants a confirmation');
    expect(unsubscribeSentence({ status: 'needs-human', method: 'link', reason: 'unclear' }))
      .toContain('could not tell');
    // The mailto rung's own reasons (S8). `mailto-pending` was the stub's placeholder and is gone; each
    // of these is about a MAIL rather than a page, so none of them may fall through to the page wording.
    expect(unsubscribeSentence({ status: 'needs-human', method: 'mailto', reason: 'send-unknown' }))
      .toContain('never confirmed it');
    expect(unsubscribeSentence({ status: 'needs-human', method: 'mailto', reason: 'mailto-console-only' }))
      .toContain('from your own click');
    expect(unsubscribeSentence({ status: 'failed', method: 'mailto', reason: 'cannot-send' }))
      .toContain('no outgoing mail set up');
    expect(unsubscribeSentence({ status: 'failed', method: 'mailto', reason: 'mailto-many-recipients' }))
      .toContain('more than one recipient');
    expect(unsubscribeSentence({ status: 'failed', method: 'mailto', reason: 'mailto-unusable' }))
      .toContain('cannot read the address');
    for (const reason of ['send-failed', 'send-refused']) {
      expect(unsubscribeSentence({ status: 'failed', method: 'mailto', reason }))
        .toContain('Nothing left your mailbox');
    }
    expect(unsubscribeSentence({ status: 'failed', method: 'link', reason: 'blocked-host' }))
      .toContain('not one Walnut is willing to open');
    expect(unsubscribeSentence({ status: 'failed', method: 'link', reason: 'timeout' }))
      .toContain('did not answer in time');
    expect(unsubscribeSentence({ status: 'failed', method: 'link', reason: 'too-many-redirects' }))
      .toContain('kept redirecting');
    expect(unsubscribeSentence({ status: 'failed', method: 'one-click', reason: 'http-403' }))
      .toContain('refused (http-403)');
    expect(unsubscribeSentence({ status: 'in-flight', method: 'mailto' }))
      .toContain('is unsubscribing you');
    // Not the page wording: there was no page, and telling somebody to read one is a wrong instruction.
    expect(unsubscribeSentence({ status: 'needs-human', method: 'link', reason: 'not-a-page' }))
      .toContain('a file rather than a page');
  });

  it('never leaves a placeholder or a code where a human reads it', () => {
    for (const status of ['done', 'needs-human', 'failed', 'in-flight'] as const) {
      for (const method of ['one-click', 'mailto', 'link', 'manual'] as const) {
        const sentence = unsubscribeSentence({ status, method });
        expect(sentence.length).toBeGreaterThan(20);
        expect(sentence).toMatch(/\.$/);
        expect(sentence).not.toMatch(/undefined|\{|\}/);
      }
    }
  });
});
