/**
 * The folder beside a note that holds the files the user attached to it (photos,
 * videos, documents). Every writer names it through this constant: the data
 * repo's size sentinel (src/integrations/git-sync.ts) counts these files as the
 * user's own, not as growth. Guarded by tests/integrations/git-compaction-paging.test.ts.
 * Its own module (no imports) so test files that mock src/constants.js keep it.
 */
export const NOTE_ATTACHMENT_DIR = '_attachment';
