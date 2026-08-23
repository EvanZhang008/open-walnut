import fs from 'node:fs/promises'
import path from 'node:path'
import { CLI_RANGE, ENGINE_FLOOR, PLUGIN_API_RANGE } from './version.js'

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** Templates `walnut-plugin new --template` accepts. */
export const SCAFFOLD_TEMPLATES = ['server', 'web', 'both'] as const
export type ScaffoldTemplate = (typeof SCAFFOLD_TEMPLATES)[number]

/** Most plugins end up wanting both halves, so that is the default. */
export const DEFAULT_TEMPLATE: ScaffoldTemplate = 'both'

export interface ScaffoldOptions {
  template?: ScaffoldTemplate
}

/** The scaffolded plugin's OWN starting version, unrelated to this CLI's version. */
const INITIAL_PLUGIN_VERSION = '0.1.0'
const TYPESCRIPT_RANGE = '^5.8.0'
const NODE_TYPES_RANGE = '^22.15.0'
const REACT_RANGE = '^19.0.0'
const REACT_DOM_RANGE = '^19.0.0'
const REACT_TYPES_RANGE = '^19.0.0'
const REACT_DOM_TYPES_RANGE = '^19.0.0'

export function isScaffoldTemplate(value: string): value is ScaffoldTemplate {
  return (SCAFFOLD_TEMPLATES as readonly string[]).includes(value)
}

/** Narrow a raw `--template` string, naming every accepted value when it is wrong. */
export function assertScaffoldTemplate(value: string): ScaffoldTemplate {
  if (!isScaffoldTemplate(value)) {
    throw new Error(`Unknown template ${JSON.stringify(value)}. Use one of: ${SCAFFOLD_TEMPLATES.join(', ')}`)
  }
  return value
}

function titleFromId(id: string): string {
  return id
    .split(/[-_.]/)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ''))
    .join(' ')
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

function manifest(id: string, name: string, template: ScaffoldTemplate): string {
  const wantsServer = template !== 'web'
  const wantsWeb = template !== 'server'
  return json({
    id,
    name,
    description: `${name} for Open Walnut.`,
    version: INITIAL_PLUGIN_VERSION,
    apiVersion: 1,
    engines: { walnut: ENGINE_FLOOR },
    ...(wantsServer ? { server: 'dist/server.mjs' } : {}),
    ...(wantsWeb ? { web: 'dist/web.mjs' } : {}),
    build: {
      ...(wantsServer ? { server: 'src/server.ts' } : {}),
      ...(wantsWeb ? { web: 'src/web.tsx' } : {}),
    },
  })
}

function packageJson(id: string, template: ScaffoldTemplate): string {
  const wantsServer = template !== 'web'
  const wantsWeb = template !== 'server'
  return json({
    name: id,
    version: INITIAL_PLUGIN_VERSION,
    type: 'module',
    files: ['manifest.json', 'dist', 'skills', 'app'],
    scripts: {
      build: 'walnut-plugin build',
      dev: 'walnut-plugin dev',
      typecheck: 'tsc --noEmit',
      'plugin:test': 'npm run typecheck',
      test: 'walnut-plugin test',
    },
    devDependencies: {
      '@open-walnut/plugin-api': PLUGIN_API_RANGE,
      '@open-walnut/plugin-cli': CLI_RANGE,
      ...(wantsServer ? { '@types/node': NODE_TYPES_RANGE } : {}),
      ...(wantsWeb ? { '@types/react': REACT_TYPES_RANGE } : {}),
      ...(wantsWeb ? { '@types/react-dom': REACT_DOM_TYPES_RANGE } : {}),
      ...(wantsWeb ? { react: REACT_RANGE } : {}),
      ...(wantsWeb ? { 'react-dom': REACT_DOM_RANGE } : {}),
      typescript: TYPESCRIPT_RANGE,
    },
  })
}

function tsconfig(template: ScaffoldTemplate): string {
  const wantsWeb = template !== 'server'
  return json({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      ...(wantsWeb ? { jsx: 'react-jsx' } : {}),
      lib: wantsWeb ? ['ES2022', 'DOM'] : ['ES2022'],
    },
    include: wantsWeb ? ['src/**/*.ts', 'src/**/*.tsx'] : ['src/**/*.ts'],
  })
}

function serverEntry(): string {
  return `import type { WalnutServerApi } from '@open-walnut/plugin-api/server'

export async function activate(walnut: WalnutServerApi) {
  walnut.log.info('activated')

  walnut.registry.tool({
    name: 'ping',
    description: 'Answer with pong, so you can see this plugin from the Personal AI.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return { reply: 'pong', pluginId: walnut.pluginId }
    },
  })
}
`
}

function webEntry(id: string, name: string): string {
  const cssClass = `${id.replace(/[^a-z0-9]+/g, '-')}-page`
  return `import { useState } from 'react'
import type { WalnutWebApi } from '@open-walnut/plugin-api/web'

export function activate(walnut: WalnutWebApi) {
  function Page() {
    const [count, setCount] = useState(0)
    return (
      <main className="${cssClass}">
        <h1>${name}</h1>
        <p>This page renders inside Walnut's own React tree, so it shares the host's React and theme.</p>
        <button type="button" onClick={() => setCount((value) => value + 1)}>
          Clicked {count} times
        </button>
      </main>
    )
  }

  function Panel({ panelKey }: { panelKey: string }) {
    return <section data-panel-key={panelKey}>${name} is running.</section>
  }

  walnut.ui.nav({ id: 'main', label: '${name}', path: '/plugins/${id}' })
  walnut.ui.page({ id: 'main', path: '/plugins/${id}', title: '${name}', component: Page })
  walnut.ui.panel({ id: 'summary', title: '${name}', component: Panel, defaultSpan: 1 })
  walnut.ui.injectCss(\`
    .${cssClass} { display: grid; gap: 12px; padding: 24px; }
    .${cssClass} p { margin: 0; color: var(--fg-muted); }
  \`)

  walnut.log.info('web surface activated')
}
`
}

function readme(id: string, name: string, template: ScaffoldTemplate): string {
  const wantsServer = template !== 'web'
  const wantsWeb = template !== 'server'
  const entries = [
    ...(wantsServer ? ['`src/server.ts` runs in the Walnut server: tools, ops, cron actions, hooks, storage.'] : []),
    ...(wantsWeb ? [`\`src/web.tsx\` runs in the web console: nav item, page, and panel at \`/plugins/${id}\`.`] : []),
  ]
  return `# ${name}

An Open Walnut plugin (\`${template}\` template).

- ${entries.join('\n- ')}
- \`manifest.json\` declares the id, the entry files, and the Walnut version floor.

## Develop

\`\`\`bash
npm install
npx walnut-plugin dev
\`\`\`

\`dev\` builds, links this directory into \`~/.open-walnut/plugins/${id}\`, then rebuilds and reloads the plugin on every save. Walnut can be offline while you work; the link loads on its next start.

## Check and ship

\`\`\`bash
npx walnut-plugin validate       # manifest and entry paths
npx walnut-plugin test           # validate, build, then run plugin:test
npx walnut-plugin publish-check  # what a release must pass
\`\`\`

Plugin guide: https://github.com/EvanZhang008/open-walnut/blob/main/docs/reference/plugin-development.md
`
}

/**
 * Create a plugin project. Every write uses the `wx` flag, so an existing file is
 * NEVER overwritten: scaffolding into a directory that already holds a plugin
 * fails with EEXIST instead of quietly replacing someone's work.
 */
export async function scaffoldPlugin(
  id: string,
  destination = id,
  options: ScaffoldOptions = {},
): Promise<string> {
  if (!ID_PATTERN.test(id)) throw new Error('Plugin id must match /^[a-z0-9][a-z0-9._-]{0,63}$/')
  const template = assertScaffoldTemplate(options.template ?? DEFAULT_TEMPLATE)
  const root = path.resolve(destination)
  const name = titleFromId(id)

  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'manifest.json'), manifest(id, name, template), { flag: 'wx' })
  await fs.writeFile(path.join(root, 'package.json'), packageJson(id, template), { flag: 'wx' })
  await fs.writeFile(path.join(root, 'tsconfig.json'), tsconfig(template), { flag: 'wx' })
  await fs.writeFile(path.join(root, '.gitignore'), 'dist/\nnode_modules/\n', { flag: 'wx' })
  await fs.writeFile(path.join(root, 'README.md'), readme(id, name, template), { flag: 'wx' })
  if (template !== 'web') {
    await fs.writeFile(path.join(root, 'src', 'server.ts'), serverEntry(), { flag: 'wx' })
  }
  if (template !== 'server') {
    await fs.writeFile(path.join(root, 'src', 'web.tsx'), webEntry(id, name), { flag: 'wx' })
  }
  return root
}
