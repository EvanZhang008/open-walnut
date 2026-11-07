/**
 * Where a draft's uploaded attachments are kept beside its words, on this
 * device only: `walnut.attachments:<draft key>`. Not a `draft:` key, so the
 * words' mirror (utils/drafts.ts) never takes them for text. Written by
 * ChatInput, removed with the draft (drafts.ts discardDraft).
 */
export const KEPT_ATTACHMENTS_PREFIX = 'walnut.attachments:';
