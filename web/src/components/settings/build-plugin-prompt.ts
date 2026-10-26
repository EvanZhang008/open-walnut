/**
 * What the Build a plugin flows hand a session, and the scaffold command a person runs
 * by hand. Shared by BuildPluginCard (/plugins/new) and the Apps page's MakeAppCard.
 */

/**
 * The scaffold command that works today. The author packages are not on npm yet
 * (`npx @open-walnut/plugin-cli` answers 404), so it runs from a clone of the
 * repository, the same loop README.md shows. Two lines: build the CLI once, then
 * scaffold, link and watch.
 */
export const PLUGIN_CREATE_COMMAND = 'npm run build:plugins && node packages/plugin-cli/dist/cli.js new my-plugin --dev --no-install'

/** Where AI-built plugins live. quick-start expands `~` server-side and
 *  `createCwd` mkdirs it, so this works on a fresh machine. */
export const BUILD_CWD = '~/walnut-plugins'

export function buildPrompt(request: string, installDir: string | null): string {
  const want = request.trim()
  // The author packages are not on npm yet, so the CLI comes from a Walnut checkout.
  // Hand the session the one it has (a fresh ~/walnut-plugins has nothing to read).
  const cli = installDir
    ? `Use the plugin CLI from the Walnut checkout at ${installDir}: run \`npm run build:plugins\` there once (skip it when ${installDir}/packages/plugin-cli/dist/cli.js already exists), then run \`node ${installDir}/packages/plugin-cli/dist/cli.js new <name> --dev\` from the current directory. If that checkout has no packages/plugin-cli, clone https://github.com/EvanZhang008/open-walnut instead, run \`npm install && npm run build:plugins\` in it, and use its CLI the same way.`
    : 'Clone https://github.com/EvanZhang008/open-walnut, run `npm install && npm run build:plugins` in it, then run `node <checkout>/packages/plugin-cli/dist/cli.js new <name> --dev` from the current directory.'
  return [
    'Build a new Walnut plugin for me.',
    '',
    'Setup: pick a short kebab-case name from my request (ask me if unclear).',
    cli,
    'Keep that watcher running: it links the plugin into my running Walnut and',
    'hot-reloads it on every save, so I can watch it appear in my sidebar while you',
    'work. The scaffold\'s README documents the full plugin API.',
    '',
    want ? `What I want: ${want}` : 'Start by asking me what the plugin should do.',
  ].join('\n')
}
