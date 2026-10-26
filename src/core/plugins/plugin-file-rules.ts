/**
 * What may live in a plugin's synced area (`plugin-files/<id>/`), shared by the SDK
 * that writes it (plugin-file-area.ts) and the data repo's auto git that commits it
 * (src/integrations/git-sync.ts). No imports, so git-sync can read it cheaply.
 */

/** Text extensions the synced area accepts and git tracks there. */
export const SYNCED_FILE_EXTENSIONS = ['.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.csv', '.toml'] as const

/** One synced file may not be larger than this; git-sync also keeps a bigger NEW file out of a commit. */
export const SYNCED_FILE_MAX_BYTES = 1024 * 1024

/** The folder under WALNUT_HOME, relative, as git sees it. */
export const SYNCED_FILES_DIR = 'plugin-files'

/** Folder names git never tracks under plugin-files/ (besides hidden names), so the SDK refuses them too. */
export const SYNCED_REFUSED_FOLDERS = ['node_modules'] as const
