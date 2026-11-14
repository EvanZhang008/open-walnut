/**
 * The folder beside config.yaml that holds its dated copies (config-history.ts).
 * A leaf module with no imports: first-run.ts reads the name, and first-run is
 * loaded by the compiled file before its runtime root is set, where nothing may
 * pull in a module that reads `import.meta.url`
 * (tests/binary/runtime-root-imports.test.ts).
 */
export const CONFIG_HISTORY_DIR_NAME = 'config.yaml.history';
