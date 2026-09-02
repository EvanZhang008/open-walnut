/**
 * The `search:` section of config.yaml.
 *
 * One field, because the search engine has no user-facing knobs left: the
 * embedding model is a preset chosen by env (WALNUT_SEARCH_V2_EMBED_MODEL),
 * scoring is fixed, and there is nothing to download. Retired keys
 * (`qmd_model`, `rrf_alpha`, `enabled`, and the Ollama-era `model`/
 * `ollama_url`/`dimensions`/`keep_alive`) are simply ignored if an old
 * config.yaml still carries them — config parsing tolerates unknown keys, so
 * nobody's file breaks.
 */
export interface EmbeddingConfig {
  /** Vault-relative folder prefixes excluded from notes search results
   *  (e.g. ['archive']). Matching is per path segment, case-insensitive.
   *  Content stays indexed — exclusion is applied at query time, so toggling
   *  the setting needs no reindex. */
  excluded_folders?: string[];
}
