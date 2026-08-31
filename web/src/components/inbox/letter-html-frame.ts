/**
 * The letter reader's frame — a thin re-export.
 *
 * The canonical document + security floor lives in
 * `src/core/human-inbox/letter-frame.ts` (aliased as `@open-walnut/letter-frame`)
 * because the SERVER needs the identical wrap: a body too big to inline is
 * streamed from `/api/v1/human-inbox/:id/body?frame=1`, and it must land inside
 * exactly the frame this file builds for the inline path. Two copies would mean a
 * 100MB letter rendering under a weaker policy than a 100KB one.
 *
 * Kept as a module here (rather than importing the alias everywhere) so the
 * existing import sites and tests/web/letter-html-frame.test.ts stay put.
 */

export {
  LETTER_IFRAME_SANDBOX,
  LETTER_FRAME_CSP_VALUE,
  planLetterFrame,
  wrapLetterHtml,
} from '@open-walnut/letter-frame';
