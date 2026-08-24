import fs from 'node:fs/promises'
import path from 'node:path'
import { appPath, DEFAULT_APP_ID } from './app-route.js'
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
      validate: 'walnut-plugin validate',
      link: 'walnut-plugin link',
      'publish-check': 'walnut-plugin publish-check',
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

/** Mirrors the host's `pluginToolName`: the agent-visible name is the plugin id, non-word chars folded to `_`, then `_<tool>`. */
export function hostToolName(pluginId: string, localName: string): string {
  const prefix = `${pluginId.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}_`
  return localName.startsWith(prefix) ? localName : `${prefix}${localName}`
}

function serverEntry(id: string): string {
  return `import type { WalnutServerApi } from '@open-walnut/plugin-api/server'

export async function activate(walnut: WalnutServerApi) {
  walnut.log.info('activated')

  // Registered as 'ping'; Walnut prefixes it with the plugin id, so the Personal AI calls '${hostToolName(id, 'ping')}'.
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
  const cssClass = `${id.replace(/[^a-z0-9]+/g, '-')}-app`
  return `import { useState } from 'react'
import type { WalnutWebApi } from '@open-walnut/plugin-api/web'

export function activate(walnut: WalnutWebApi) {
  // The host passes App props; a component with no props is a valid App.
  function App() {
    const [count, setCount] = useState(0)
    return (
      <main className="${cssClass}">
        <h1>${name}</h1>
        <p>This App renders inside Walnut's own React tree, so it shares the host's React and theme.</p>
        <button type="button" onClick={() => setCount((value) => value + 1)}>
          Clicked {count} times
        </button>
      </main>
    )
  }

  // One App is the whole web surface; Walnut owns the route, and \`app.path\` is where it mounted.
  const app = walnut.ui.app({ id: '${DEFAULT_APP_ID}', title: '${name}', component: App })

  walnut.ui.injectCss(\`
    .${cssClass} { display: grid; gap: 12px; padding: 24px; }
    .${cssClass} p { margin: 0; color: var(--fg-muted); }
  \`)

  walnut.log.info(\`App mounted at \${app.path}\`)
}
`
}

function skill(id: string, name: string, template: ScaffoldTemplate): string {
  const gives = [
    ...(template !== 'web'
      ? [`A tool that answers with \`pong\`. Call it as \`${hostToolName(id, 'ping')}\`: Walnut prefixes every plugin tool with the plugin id, so the local name \`ping\` is not what you call.`]
      : []),
    ...(template !== 'server' ? [`An App at \`${appPath(id)}\`.`] : []),
  ]
  return `---
name: ${id}
description: What the ${name} plugin does and how to use it. Use when working with ${name} in Open Walnut.
---

# ${name}

Walnut loads every skill under this plugin's \`skills/\` directory, so the Personal AI can read this file when it is relevant.

## What this plugin gives you

- ${gives.join('\n- ')}

## Notes

Replace this text with the instructions an agent needs: when to reach for this plugin, what to call, and what a good result looks like.
`
}

function readme(id: string, name: string, template: ScaffoldTemplate): string {
  const wantsServer = template !== 'web'
  const wantsWeb = template !== 'server'
  const entries = [
    ...(wantsServer ? ['`src/server.ts` runs in the Walnut server: tools, ops, cron actions, hooks, storage.'] : []),
    ...(wantsWeb ? [`\`src/web.tsx\` runs in the web console: one App, which Walnut mounts at \`${appPath(id)}\`.`] : []),
  ]
  return `# ${name}

An Open Walnut plugin (\`${template}\` template).

- ${entries.join('\n- ')}
- \`manifest.json\` declares the id, the entry files, and the Walnut version floor.
- \`skills/${id}/SKILL.md\` is what the Personal AI reads about this plugin.

## Develop

\`\`\`bash
npm run dev
\`\`\`

One command is the whole loop: it builds, links this directory into \`~/.open-walnut/plugins/${id}\`, tells the running Walnut to load it${wantsWeb ? `, prints the App URL,` : ','} then rebuilds and reloads on every save. The first link needs no restart. Walnut can be offline while you work; the link loads on its next start.

## Check and ship

\`\`\`bash
npm run validate       # manifest and entry paths
npm test               # validate, build, then run plugin:test
npm run link           # link once, without watching
npm run publish-check  # what a release must pass
\`\`\`

Plugin guide: https://github.com/EvanZhang008/open-walnut/blob/main/docs/reference/plugin-development.md
`
}

/** Every file this template writes, relative to the project root. */
export function scaffoldFiles(id: string, template: ScaffoldTemplate = DEFAULT_TEMPLATE): string[] {
  return [
    'manifest.json',
    'package.json',
    'tsconfig.json',
    '.gitignore',
    'README.md',
    ...(template !== 'web' ? [path.join('src', 'server.ts')] : []),
    ...(template !== 'server' ? [path.join('src', 'web.tsx')] : []),
    path.join('skills', id, 'SKILL.md'),
  ]
}

function existingFileError(root: string, files: string[]): NodeJS.ErrnoException {
  const error = new Error(
    `Refusing to scaffold into ${root}: these files already exist: ${files.join(', ')}`,
  ) as NodeJS.ErrnoException
  error.code = 'EEXIST'
  return error
}

/** Create a plugin project: pre-flight so a collision writes NOTHING, then `wx` writes so a concurrent scaffold still cannot clobber. */
export async function scaffoldPlugin(
  id: string,
  destination = id,
  options: ScaffoldOptions = {},
): Promise<string> {
  if (!ID_PATTERN.test(id)) throw new Error('Plugin id must match /^[a-z0-9][a-z0-9._-]{0,63}$/')
  const template = assertScaffoldTemplate(options.template ?? DEFAULT_TEMPLATE)
  const root = path.resolve(destination)
  const name = titleFromId(id)

  const planned = scaffoldFiles(id, template)
  const present = (await Promise.all(planned.map(async (file) => {
    try {
      await fs.access(path.join(root, file))
      return file
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return undefined
    }
  }))).filter((file): file is string => file !== undefined)
  if (present.length > 0) throw existingFileError(root, present)

  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.writeFile(path.join(root, 'manifest.json'), manifest(id, name, template), { flag: 'wx' })
  await fs.writeFile(path.join(root, 'package.json'), packageJson(id, template), { flag: 'wx' })
  await fs.writeFile(path.join(root, 'tsconfig.json'), tsconfig(template), { flag: 'wx' })
  await fs.writeFile(path.join(root, '.gitignore'), 'dist/\nnode_modules/\n', { flag: 'wx' })
  await fs.writeFile(path.join(root, 'README.md'), readme(id, name, template), { flag: 'wx' })
  if (template !== 'web') {
    await fs.writeFile(path.join(root, 'src', 'server.ts'), serverEntry(id), { flag: 'wx' })
  }
  if (template !== 'server') {
    await fs.writeFile(path.join(root, 'src', 'web.tsx'), webEntry(id, name), { flag: 'wx' })
  }
  // A native plugin's `skills/` directory is discovered by convention, so this one file is a live skill.
  await fs.mkdir(path.join(root, 'skills', id), { recursive: true })
  await fs.writeFile(path.join(root, 'skills', id, 'SKILL.md'), skill(id, name, template), { flag: 'wx' })
  return root
}
