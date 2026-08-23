import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginApiRequire = createRequire(path.join(root, 'packages', 'plugin-api', 'package.json'))
const reactTypesDir = path.dirname(pluginApiRequire.resolve('@types/react/package.json'))
const documentPath = path.join(root, 'docs/reference/plugin-development.md')
const markdown = await readFile(documentPath, 'utf8')
const pattern = /```(ts|tsx)\s+compile=([a-z0-9-]+)\n([\s\S]*?)```/g
const snippets = [...markdown.matchAll(pattern)]

if (snippets.length === 0) {
  throw new Error('No compile-marked Plugin documentation snippets found')
}

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'walnut-plugin-docs-'))
try {
  const files = []
  for (const [index, match] of snippets.entries()) {
    const extension = match[1] === 'tsx' ? 'tsx' : 'ts'
    const file = path.join(tempDir, `${String(index + 1).padStart(2, '0')}-${match[2]}.${extension}`)
    await writeFile(file, match[3], 'utf8')
    files.push(file)
  }

  const configPath = path.join(tempDir, 'tsconfig.json')
  await writeFile(configPath, JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
      jsx: 'react-jsx',
      lib: ['ES2022', 'DOM'],
      baseUrl: root,
      paths: {
        '@open-walnut/plugin-api/server': ['packages/plugin-api/src/server.ts'],
        '@open-walnut/plugin-api/web': ['packages/plugin-api/src/web.ts'],
        react: [path.join(reactTypesDir, 'index.d.ts')],
        'react/jsx-runtime': [path.join(reactTypesDir, 'jsx-runtime.d.ts')],
      },
    },
    files,
  }, null, 2))

  const tsc = path.join(root, 'node_modules/.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc')
  execFileSync(tsc, ['--project', configPath], { cwd: root, stdio: 'pipe' })
  console.log(`Plugin documentation snippets typechecked: ${snippets.length}`)
} catch (error) {
  if (error?.stdout) process.stderr.write(String(error.stdout))
  if (error?.stderr) process.stderr.write(String(error.stderr))
  throw error
} finally {
  await rm(tempDir, { recursive: true, force: true })
}
