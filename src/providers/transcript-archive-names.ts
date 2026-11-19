/**
 * The names the session history archive gives its files (transcript-archive.ts), in a module of
 * their own so a reader that only needs a name (the server's transcript probe, the remote
 * loading check) does not load the archive itself.
 */
export const ARCHIVE_SUFFIX = '.gz'
export const MANIFEST_SUFFIX = '.walnut-archive.json'
