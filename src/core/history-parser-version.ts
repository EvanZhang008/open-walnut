/**
 * The version of the parse a ready view holds: a hash of the parser's and the ready-view
 * builder's source (scripts/history-parser-version.mjs, which writes this file). A host's
 * daemon answers it with every ready view, and the server keeps a view only when it is its own
 * (history-ready-view.ts), so a daemon on an older parser never paints this server's history.
 * Generated: run `bun scripts/history-parser-version.mjs --write` after editing a file it lists.
 */
export const HISTORY_PARSER_VERSION = 'baef33071efe17e0';
